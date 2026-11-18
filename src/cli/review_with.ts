/** `review --with=PATH[@BRANCH]` (issue 81): a companion checkout, read as
 * context. Without `@BRANCH` the companion's current branch and working tree
 * are read, the way local review reads its own checkout. With `@BRANCH` that
 * branch is diffed against its merge base with the companion's default
 * branch, and the checkout is never switched. */
import { resolve } from "node:path";
import { die } from "./error.ts";
import { CliError } from "./error.ts";
import { runCommand, type Run } from "../pr/checkout.ts";
import { detectRemoteRepo, gitRoot } from "../local/git_ops.ts";
import { buildLocalRevision, resolveBaseRef } from "../local/git_revision.ts";
import { type Companion, MAX_COMPANIONS } from "../review/companions.ts";
import type { CompanionSearch } from "../pr/companion_tools.ts";
import {
  searchNonCodeTool,
  searchOptionsFor,
} from "../tools/search_non_code.ts";
import { statSync } from "../util/runtime.ts";
import type { GitHubClient, Json } from "../types.ts";
import { readConfig } from "../config.ts";
import { GhClient } from "../github/gh.ts";
import { PatClient } from "../github/pat.ts";

/** A companion read from a checkout on this machine. */
export type LocalCompanion = Companion & {
  /** The checkout's git root, where search runs. */
  root: string;
};

/** The `--with` values of a review, checked for what can be told without
 * git. `die`s with exit 2. */
export function withFlagValues(args: string[]): string[] {
  const values = args
    .filter((arg) => arg.startsWith("--with="))
    .map((arg) => arg.slice("--with=".length));
  if (values.some((value) => value.trim() === "")) {
    die("--with: give a path, as --with=PATH or --with=PATH@BRANCH");
  }
  if (values.length > MAX_COMPANIONS) {
    die(`--with: at most ${MAX_COMPANIONS} companions`);
  }
  return values;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** PATH and BRANCH of one value. A value that names a folder is a path
 * whole, so a folder with `@` in its name still works. Otherwise the text
 * after the last `@` is the branch. */
export function splitWithValue(
  value: string,
  cwd = process.cwd(),
): { path: string; branch?: string } {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1 || isDirectory(resolve(cwd, value))) {
    return { path: value };
  }
  return { path: value.slice(0, at), branch: value.slice(at + 1) };
}

/** The remote local review reads its base from: `upstream`, then `origin`,
 * then the first one. */
async function remoteName(root: string, run: Run): Promise<string> {
  const names = (await run("git", ["remote"], root)).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    ["upstream", "origin"].find((name) => names.includes(name)) ??
    names[0] ??
    "origin"
  );
}

/** The commit `branch` points at, a local branch first, then the remote's. */
async function branchCommit(
  root: string,
  remote: string,
  branch: string,
  run: Run,
): Promise<string | undefined> {
  for (const ref of [
    `refs/heads/${branch}`,
    `refs/remotes/${remote}/${branch}`,
  ]) {
    const found = await run(
      "git",
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      root,
    );
    if (found.code === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return undefined;
}

/** The name of the branch a checkout is on, or its short commit when it is
 * on none. */
async function checkedOutBranch(root: string, run: Run): Promise<string> {
  const named = await run(
    "git",
    ["symbolic-ref", "--short", "-q", "HEAD"],
    root,
  );
  if (named.code === 0 && named.stdout.trim()) return named.stdout.trim();
  const sha = await run("git", ["rev-parse", "--short", "HEAD"], root);
  return sha.stdout.trim() || "HEAD";
}

async function mergeBaseOf(
  root: string,
  a: string,
  b: string,
  run: Run,
): Promise<string | undefined> {
  const found = await run("git", ["merge-base", a, b], root);
  return found.code === 0 && found.stdout.trim()
    ? found.stdout.trim()
    : undefined;
}

/** A git failure in a companion, as a `--with` usage error that names it. */
async function named<T>(path: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CliError && !error.message.startsWith("--with:")) {
      die(`--with: ${path}: ${error.message}`);
    }
    throw error;
  }
}

/** Reads every `--with` companion. `reviewed` is the repository under review
 * and, for local and remote review, its git root. `die`s with exit 2 on the
 * cases of the flag table. Every companion starts as private until its
 * visibility is read. */
export async function loadCompanions(
  values: string[],
  reviewed: { repo: string; root?: string },
  run: Run = runCommand,
  cwd = process.cwd(),
): Promise<LocalCompanion[]> {
  const out: LocalCompanion[] = [];
  const reviewedRoot = reviewed.root ? resolve(reviewed.root) : undefined;
  for (const value of values) {
    const { path, branch } = splitWithValue(value, cwd);
    const dir = resolve(cwd, path);
    if (!isDirectory(dir)) die(`--with: ${path} is not a git repository`);
    let root: string;
    try {
      root = resolve(await gitRoot(dir, run));
    } catch {
      die(`--with: ${path} is not a git repository`);
    }
    if (reviewedRoot && root === reviewedRoot) {
      die(`--with: ${path} is the repository under review`);
    }
    const repo = await named(path, () =>
      detectRemoteRepo(root, undefined, run),
    );
    if (repo.toLowerCase() === reviewed.repo.toLowerCase()) {
      die(`--with: ${path} is the repository under review`);
    }
    if (out.some((item) => item.repo.toLowerCase() === repo.toLowerCase())) {
      die(`--with: ${repo} is given more than once`);
    }
    const remote = await remoteName(root, run);
    let files: Companion["files"];
    let label: string;
    if (branch !== undefined) {
      const commit = await branchCommit(root, remote, branch, run);
      if (!commit) die(`--with: no branch ${branch} in ${repo}`);
      const base = await named(path, () =>
        resolveBaseRef(root, remote, undefined, run),
      );
      const since = await mergeBaseOf(root, base.ref, commit, run);
      if (!since) {
        die(
          `--with: ${branch} has no merge base with ${base.label} in ${repo}`,
        );
      }
      // Two commits: the checkout and its working tree are never touched.
      files = (
        await named(path, () =>
          buildLocalRevision(root, since, base.label, run, commit),
        )
      ).revision.files;
      label = branch;
    } else {
      const base = await named(path, () =>
        resolveBaseRef(root, remote, undefined, run),
      );
      const since = await mergeBaseOf(root, base.ref, "HEAD", run);
      if (!since) {
        die(`--with: ${path} has no merge base with ${base.label} in ${repo}`);
      }
      files = (
        await named(path, () =>
          buildLocalRevision(root, since, base.label, run),
        )
      ).revision.files;
      label = await checkedOutBranch(root, run);
    }
    out.push({ repo, branch: label, files, private: true, root });
  }
  return out;
}

/** `true` private, `false` public, `null` when GitHub did not say. */
export async function repoVisibility(
  client: Pick<GitHubClient, "request"> | undefined,
  repo: string,
): Promise<boolean | null> {
  if (!client) return null;
  try {
    const found = await client.request<Json>(`repos/${repo}`);
    if (found.private === true) return true;
    if (found.private === false) return false;
    return null;
  } catch {
    return null;
  }
}

/** Reads the visibility of the reviewed repository and of each companion
 * from the GitHub API, at review time. A companion is private in this review
 * when it is private or could not be read, and the reviewed repository is
 * not known to be private. */
export async function readCompanionVisibility<T extends Companion>(
  companions: T[],
  reviewedRepo: string,
  client: Pick<GitHubClient, "request"> | undefined,
): Promise<T[]> {
  if (companions.length === 0) return companions;
  const [reviewed, ...each] = await Promise.all([
    repoVisibility(client, reviewedRepo),
    ...companions.map((companion) => repoVisibility(client, companion.repo)),
  ]);
  return companions.map((companion, index) => ({
    ...companion,
    private: each[index] !== false && reviewed !== true,
  }));
}

/** Searches a companion checkout, as `search-non-code` searches the
 * reviewed one, with the companion repository's own search settings. */
export function localCompanionSearch(
  companions: LocalCompanion[],
): CompanionSearch {
  return async (repo, args) => {
    const companion = companions.find((item) => item.repo === repo)!;
    return await searchNonCodeTool(
      companion.root,
      searchOptionsFor(companion.repo),
    ).run(args);
  };
}

/** The GitHub client of the saved config, for a run that has no options of
 * its own: a remote review reads visibility with the user's own auth. */
export function configGitHubClient(): GitHubClient {
  const config = readConfig();
  return config.auth === "pat"
    ? new PatClient(config.githubPat ?? "")
    : new GhClient(false);
}
