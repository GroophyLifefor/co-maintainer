/** Companion pull requests (issue 81): App review and CLI pull request review
 * read the companions of a pull request from GitHub. The repository's
 * `companions` setting lists the repositories that may be read. A
 * `Companion: owner/repo#N` line in the pull request body names a companion
 * pull request, and a listed repository with no such line is matched by an
 * open pull request with the same head branch name. A repository missing
 * from the setting is never read, whatever the body says, so a pull request
 * from a fork cannot make the review read another repository. */
import type { GitHubClient, Json } from "../types.ts";
import {
  type Companion,
  type CompanionJson,
  MAX_COMPANIONS,
} from "../review/companions.ts";
import type { CoverageWarning } from "../review/coverage.ts";
import { githubFileToRevisionFile } from "./github_revision.ts";
import { ensureWorktree, type Run, runCommand } from "./checkout.ts";
import { setGitHubAuth } from "./git_auth.ts";
import {
  searchNonCodeTool,
  searchOptionsFor,
} from "../tools/search_non_code.ts";
import type { CompanionSearch } from "./companion_tools.ts";
import { toolError } from "./codegraph_tool_args.ts";
import { repoVisibility } from "../cli/review_with.ts";

/** A GitHub repository name, the characters GitHub allows. */
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `Companion: owner/repo#N` on a line of its own. */
const BODY_LINE =
  /^[ \t]*companion[ \t]*:[ \t]*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]{0,9})[ \t]*$/i;

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The `--companions` value of `set --repo`, checked. `undefined` for a blank
 * value, which clears the setting. Throws an error whose message is the
 * usage error to print. */
export function parseCompanionsSetting(
  raw: string,
  repo: string,
): string[] | undefined {
  if (raw.trim() === "") return undefined;
  const names = raw.split(",").map((name) => name.trim());
  const out: string[] = [];
  for (const name of names) {
    if (!REPO_NAME.test(name)) {
      throw new Error(
        `--companions: ${name || "an empty name"} is not owner/repo`,
      );
    }
    if (sameRepo(name, repo)) {
      throw new Error(`--companions: ${name} is the repository itself`);
    }
    if (out.some((item) => sameRepo(item, name))) {
      throw new Error(`--companions: ${name} is given more than once`);
    }
    out.push(name);
  }
  if (out.length > MAX_COMPANIONS) {
    throw new Error(`--companions: at most ${MAX_COMPANIONS} repositories`);
  }
  return out;
}

/** The `Companion:` lines of a pull request body that name a listed
 * repository, in body order, one per repository, at most 5. The name is
 * spelled as the setting spells it. Every other line is ignored. */
export function companionLines(
  body: string,
  listed: string[],
): { repo: string; pr: number }[] {
  const out: { repo: string; pr: number }[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = BODY_LINE.exec(line);
    if (!match) continue;
    const repo = listed.find((name) => sameRepo(name, match[1]!));
    if (!repo || out.some((item) => sameRepo(item.repo, repo))) continue;
    out.push({ repo, pr: Number(match[2]) });
    if (out.length === MAX_COMPANIONS) break;
  }
  return out;
}

/** A companion read from a pull request on GitHub. */
export type PrCompanion = Companion & {
  source: "pr-body" | "branch-name";
  /** The companion pull request, `null` when the branch name matched none
   * or the repository could not be read. */
  pr: number | null;
  status: "read" | "empty" | "unreachable";
  /** Where search checks the companion out: its pull request's head. */
  head?: { pr: number; sha: string };
};

/** The client that reads `repo`, or `undefined` when none can. App review
 * finds the installation of the companion repository, CLI pull request
 * review uses the user's own GitHub auth. */
export type CompanionClientFor = (
  repo: string,
) => Promise<GitHubClient | undefined>;

type Planned = {
  repo: string;
  source: PrCompanion["source"];
  pr: number | null;
};

/** What to read: the body lines first, in body order, then each listed
 * repository without a body line, by branch name, in setting order. */
function plan(body: string, listed: string[]): Planned[] {
  const lines = companionLines(body, listed);
  return [
    ...lines.map((line) => ({
      repo: line.repo,
      source: "pr-body" as const,
      pr: line.pr,
    })),
    ...listed
      .filter((name) => !lines.some((line) => sameRepo(line.repo, name)))
      .map((repo) => ({ repo, source: "branch-name" as const, pr: null })),
  ].slice(0, MAX_COMPANIONS);
}

/** The open pull request of `repo` whose head branch is `branch`. The
 * `head` filter narrows the list on GitHub, and the branch is compared here
 * too. */
async function openPullByBranch(
  client: GitHubClient,
  repo: string,
  branch: string,
): Promise<Json | undefined> {
  // A pull request from a fork has its head in another owner's repository,
  // so the open list is read without a head filter and matched by branch
  // name. One from the companion repository itself wins over a fork's.
  const matches: Json[] = [];
  for (let page = 1; page <= BRANCH_LOOKUP_MAX_PAGES; page++) {
    const list = await client.request<Json[]>(
      `repos/${repo}/pulls?state=open&per_page=100&page=${page}`,
    );
    const rows = Array.isArray(list) ? list : [];
    for (const pull of rows) {
      const head = pull.head as Json | undefined;
      if (String(head?.ref ?? "") === branch && pull.state !== "closed") {
        matches.push(pull);
      }
    }
    if (rows.length < 100) break;
  }
  const own = matches.find((pull) => {
    const headRepo = (pull.head as Json | undefined)?.repo as Json | undefined;
    return (
      String(headRepo?.full_name ?? "").toLowerCase() === repo.toLowerCase()
    );
  });
  return own ?? matches[0];
}

/** Pages of open pull requests the branch name lookup reads, 100 each. */
const BRANCH_LOOKUP_MAX_PAGES = 5;

function unreachable(item: Planned): PrCompanion {
  return {
    repo: item.repo,
    branch: "",
    files: [],
    private: true,
    source: item.source,
    pr: item.pr,
    status: "unreachable",
  };
}

/** Reads one planned companion. A closed or merged pull request is read
 * too: `pulls/N/files` holds its final diff. */
async function readOne(
  item: Planned,
  branch: string,
  clientFor: CompanionClientFor,
  log: (message: string) => void,
): Promise<{ companion: PrCompanion; client?: GitHubClient }> {
  const name = item.pr === null ? item.repo : `${item.repo}#${item.pr}`;
  let client: GitHubClient | undefined;
  try {
    client = await clientFor(item.repo);
  } catch (error) {
    log(`companion ${name}: no client · ${String(error)}`);
  }
  if (!client) {
    log(`companion ${name}: no installation of the App can read it`);
    return { companion: unreachable(item) };
  }
  try {
    const pull =
      item.pr === null
        ? await openPullByBranch(client, item.repo, branch)
        : await client.request<Json>(`repos/${item.repo}/pulls/${item.pr}`);
    if (!pull) {
      return {
        companion: {
          repo: item.repo,
          branch,
          files: [],
          private: true,
          source: item.source,
          pr: null,
          status: "empty",
        },
        client,
      };
    }
    const number = Number(pull.number ?? item.pr);
    const head = pull.head as Json | undefined;
    const files = (
      await client.pages<Json>(`repos/${item.repo}/pulls/${number}/files`)
    ).map((file) => githubFileToRevisionFile(file));
    // A blobless clone of a private companion fetches with this client's
    // token, never the machine's own git login.
    const token = client.gitToken?.bind(client);
    if (token) setGitHubAuth(item.repo, token);
    const sha = String(head?.sha ?? "");
    return {
      companion: {
        repo: item.repo,
        branch: String(head?.ref ?? "") || branch,
        files,
        private: true,
        source: item.source,
        pr: number,
        status: files.length === 0 ? "empty" : "read",
        ...(sha ? { head: { pr: number, sha } } : {}),
      },
      client,
    };
  } catch (error) {
    log(`companion ${name}: could not be read · ${String(error)}`);
    return { companion: unreachable(item) };
  }
}

/** `companion_unreachable`, naming the companion. */
export function unreachableWarning(companion: PrCompanion): CoverageWarning {
  const name =
    companion.pr === null
      ? companion.repo
      : `${companion.repo}#${companion.pr}`;
  return {
    code: "companion_unreachable",
    message: `The companion ${name} could not be read, so the review ran without it.`,
  };
}

/** Reads the companions of the pull request `pr` of `repo`. `listed` is the
 * repository's `companions` setting and `skip` the repositories `--with`
 * already gave. A companion that cannot be read comes back `unreachable`,
 * with a `companion_unreachable` warning, and the review goes on without
 * it. Visibility is read with each companion's own client. */
export async function readPrCompanions(input: {
  repo: string;
  pr: Json;
  listed: string[];
  reviewed: Pick<GitHubClient, "request">;
  clientFor: CompanionClientFor;
  skip?: string[];
  log?: (message: string) => void;
}): Promise<{ companions: PrCompanion[]; warnings: CoverageWarning[] }> {
  const log = input.log ?? (() => {});
  const listed = input.listed.filter(
    (name) =>
      !sameRepo(name, input.repo) &&
      !(input.skip ?? []).some((skipped) => sameRepo(skipped, name)),
  );
  if (listed.length === 0) return { companions: [], warnings: [] };
  const branch = String((input.pr.head as Json | undefined)?.ref ?? "");
  const read = await Promise.all(
    plan(String(input.pr.body ?? ""), listed).map((item) =>
      readOne(item, branch, input.clientFor, log),
    ),
  );
  const reachable = read.filter(
    ({ companion }) => companion.status !== "unreachable",
  );
  const [reviewedPrivate, ...each] = reachable.length
    ? await Promise.all([
        repoVisibility(input.reviewed, input.repo),
        ...reachable.map(({ companion, client }) =>
          repoVisibility(client, companion.repo),
        ),
      ])
    : [null];
  const companions = read.map(({ companion }) => {
    const index = reachable.findIndex((item) => item.companion === companion);
    if (index === -1) return companion;
    return {
      ...companion,
      private: each[index] !== false && reviewedPrivate !== true,
    };
  });
  return {
    companions,
    warnings: companions
      .filter((companion) => companion.status === "unreachable")
      .map(unreachableWarning),
  };
}

/** The companions a review's prompt gets: every one that could be read. */
export function readableCompanions(companions: PrCompanion[]): PrCompanion[] {
  return companions.filter((companion) => companion.status !== "unreachable");
}

export function prCompanionsJson(companions: PrCompanion[]): CompanionJson[] {
  return companions.map((companion) => ({
    repo: companion.repo,
    branch: companion.status === "unreachable" ? null : companion.branch,
    source: companion.source,
    pr: companion.pr,
    files: companion.files.length,
    status: companion.status,
  }));
}

/** Searches a companion pull request in a worktree of its head, made the
 * same way as a pull request's own worktree: a blobless clone, reused. The
 * worktree is made on the first search of that companion. A companion with
 * no pull request has nothing to check out. */
export function prCompanionSearch(
  companions: PrCompanion[],
  run: Run = runCommand,
  log: (message: string) => void = () => {},
): CompanionSearch {
  const roots = new Map<string, Promise<string>>();
  return async (repo, args) => {
    const companion = companions.find((item) => item.repo === repo);
    if (!companion?.head) {
      return toolError(
        `${repo} has no pull request for this branch, so there is no checkout of it to search`,
      );
    }
    let root = roots.get(repo);
    if (!root) {
      root = ensureWorktree(repo, companion.head.pr, companion.head.sha, run);
      roots.set(repo, root);
    }
    let dir: string;
    try {
      dir = await root;
    } catch (error) {
      log(`companion ${repo}: search unavailable · ${String(error)}`);
      return toolError(
        `${repo} could not be checked out, so it cannot be searched`,
      );
    }
    return await searchNonCodeTool(dir, searchOptionsFor(repo)).run(args);
  };
}
