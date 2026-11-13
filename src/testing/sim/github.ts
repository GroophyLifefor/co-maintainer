/** The GitHub `e2e:simulate` answers from.
 *
 * Repository data comes from the world's real git repositories: a pull request
 * is a real branch with real commits, and its files, diffs, compares and
 * commits are computed by git. Comments, reviews, check runs, issues and
 * reactions live in memory. Every write the product makes is recorded in
 * order in `writes`, so a check can see what was posted, where and when.
 *
 * Both ways the product reaches GitHub end here: the caught `fetch` (the PAT
 * and App clients) and the in-process `gh` stand-in. A call with no route is
 * answered 404 and marked unhandled, which fails a check. */
import { spawnSync } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomInt,
  verify,
} from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { SimRepo, World } from "./world.ts";

type Json = Record<string, unknown>;

export type SimUser = { login: string; type: "User" | "Bot" };

export type SimPull = {
  /** GitHub's id for the pull request, never equal to its number. */
  id: number;
  number: number;
  repo: string;
  title: string;
  body: string;
  author: string;
  /** The head lives in a fork, `<author>/<name>`, not in the repository. */
  fork: boolean;
  draft: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  state: "open" | "closed";
  mergedAt: string | null;
  mergeCommitSha: string | null;
  labels: string[];
  association: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

export type SimComment = {
  id: number;
  repo: string;
  /** The pull request or issue number. */
  number: number;
  /** `issue` is a conversation comment, `review` sits on a diff line. */
  kind: "issue" | "review";
  body: string;
  user: SimUser;
  association: string;
  path?: string;
  line?: number;
  startLine?: number;
  side?: string;
  commitId?: string;
  inReplyTo?: number;
  reviewId?: number;
  createdAt: string;
  updatedAt: string;
};

export type SimReview = {
  id: number;
  repo: string;
  number: number;
  body: string;
  state: string;
  user: SimUser;
  commitId: string;
  submittedAt: string;
};

export type SimCheckRun = {
  id: number;
  repo: string;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  output: Json | null;
  /** Every body the product sent for this run, create first. */
  updates: Json[];
};

export type SimIssue = {
  repo: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  closedBy: SimUser | null;
  user: SimUser;
};

/** One call that changed something on GitHub, in the order it happened. */
export type GithubWrite = {
  seq: number;
  /** The step that was running. */
  step: string;
  method: string;
  /** The endpoint without host or query, e.g. `repos/o/r/issues/1/comments`. */
  path: string;
  body: unknown;
  status: number;
  /** The id GitHub gave what was created or changed, when there is one. */
  id?: number;
  via: "fetch" | "gh";
  actor: string;
};

export type RouteResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export type RouteRequest = {
  method: string;
  url: URL;
  body: unknown;
  via: "fetch" | "gh";
  /** The Authorization header's token, when there was one. */
  token?: string;
  step: string;
};

/** A file whose diff is longer than this has no `patch`, as on GitHub, which
 * withholds large diffs. GitHub does not document its exact limit. */
export const MAX_PATCH_LINES = 3000;
/** GitHub lists at most this many files of a pull request. */
const MAX_PULL_FILES = 3000;
/** A compare lists at most this many files and commits. */
const MAX_COMPARE_FILES = 300;
const MAX_COMPARE_COMMITS = 250;

const notFound = (): RouteResult => ({
  status: 404,
  body: { message: "Not Found" },
});

const ok = (body: unknown, status = 200): RouteResult => ({ status, body });

function asNumber(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number)
    ? number
    : undefined;
}

/** Files to write into a commit: a string is the new content, `null` deletes
 * the file. */
export type FileChanges = Record<string, string | null>;

export type OpenPullInput = {
  title: string;
  body?: string;
  author?: string;
  fork?: boolean;
  draft?: boolean;
  /** The head branch name. Defaults to `sim/pr-<number>`. */
  branch?: string;
  labels?: string[];
  /** `author_association` on the pull request. */
  association?: string;
  files: FileChanges;
  message?: string;
};

export class SimGithub {
  readonly world: World;
  readonly pulls: SimPull[] = [];
  readonly comments: SimComment[] = [];
  readonly reviews: SimReview[] = [];
  readonly checkRuns: SimCheckRun[] = [];
  readonly issues: SimIssue[] = [];
  readonly labels = new Map<string, Set<string>>();
  readonly reactions: { path: string; content: string }[] = [];
  readonly writes: GithubWrite[] = [];
  /** The App installation every simulated repository belongs to. Its id is
   * random per world: the product caches installation tokens by id for an
   * hour, and a fixed id would hand a later flow an earlier flow's token
   * without a call to GitHub. */
  readonly installation = {
    id: 100_000 + randomInt(900_000_000),
    account: "sim",
    permissions: {
      contents: "read",
      pull_requests: "write",
      issues: "write",
      checks: "write",
      metadata: "read",
    } as Record<string, string>,
    events: ["pull_request", "issue_comment", "pull_request_review_comment"],
  };
  /** Logins whose repository permission is `read`. Everyone else writes. */
  readonly readOnly = new Set<string>();
  /** The bot the App posts as, and the user a token or `gh` posts as. */
  readonly bot: SimUser = { login: "co-maintainer-sim[bot]", type: "Bot" };
  readonly tokenUser: SimUser = { login: "sim-maintainer", type: "User" };
  /** Installation tokens this GitHub minted. */
  readonly tokens = new Set<string>();
  private nextId = 1000;
  private readonly numbers = new Map<string, number>();

  constructor(world: World) {
    this.world = world;
  }

  private repo(fullName: string): SimRepo {
    const repo = this.world.repos.get(fullName);
    if (!repo) throw new Error(`e2e:simulate has no repository ${fullName}`);
    return repo;
  }

  private git(repo: SimRepo, args: string[]): string {
    return this.world.git(repo, args).toString();
  }

  private id(): number {
    return this.nextId++;
  }

  private nextNumber(repo: string): number {
    const next = (this.numbers.get(repo) ?? 0) + 1;
    this.numbers.set(repo, next);
    return next;
  }

  /** Commits `files` on top of `parent` without touching the working tree,
   * and returns the new commit. */
  private commit(
    repo: SimRepo,
    parent: string,
    files: FileChanges,
    message: string,
  ): string {
    const index = join(this.world.root, `index-${this.id()}`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const run = (args: string[], input?: string) => {
      const result = spawnSync("git", args, { cwd: repo.dir, env, input });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
      }
      return result.stdout.toString().trim();
    };
    run(["read-tree", parent]);
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        run(["update-index", "--force-remove", "--", path]);
        continue;
      }
      const blob = run(["hash-object", "-w", "--stdin"], content);
      run(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
    }
    const tree = run(["write-tree"]);
    const sha = run(["commit-tree", tree, "-p", parent, "-m", message]);
    rmSync(index, { force: true });
    return sha;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private setRef(repo: SimRepo, ref: string, sha: string): void {
    this.git(repo, ["update-ref", ref, sha]);
  }

  private sha(repo: SimRepo, rev: string): string {
    return this.git(repo, ["rev-parse", rev]).trim();
  }

  /** Opens a pull request: a branch off the base with one commit of
   * `files`. */
  openPull(repoName: string, input: OpenPullInput): SimPull {
    const repo = this.repo(repoName);
    const number = this.nextNumber(repoName);
    const baseSha = this.sha(repo, repo.defaultBranch);
    const headSha = this.commit(
      repo,
      baseSha,
      input.files,
      input.message ?? input.title,
    );
    const at = this.now();
    const pull: SimPull = {
      id: 2_000_000_000 + this.id(),
      number,
      repo: repoName,
      title: input.title,
      body: input.body ?? "",
      author: input.author ?? "sim-contributor",
      fork: input.fork ?? false,
      draft: input.draft ?? false,
      headRef: input.branch ?? `sim/pr-${number}`,
      baseRef: repo.defaultBranch,
      headSha,
      state: "open",
      mergedAt: null,
      mergeCommitSha: null,
      labels: input.labels ?? [],
      association: input.association ?? "CONTRIBUTOR",
      createdAt: at,
      updatedAt: at,
      closedAt: null,
    };
    this.moveHead(pull, headSha);
    this.pulls.push(pull);
    return pull;
  }

  /** A fork's branch lives in the fork, so the base repository only has the
   * `refs/pull/<n>/head` GitHub keeps for every pull request. */
  private moveHead(pull: SimPull, sha: string): void {
    const repo = this.repo(pull.repo);
    if (!pull.fork) this.setRef(repo, `refs/heads/${pull.headRef}`, sha);
    this.setRef(repo, `refs/pull/${pull.number}/head`, sha);
    pull.headSha = sha;
    pull.updatedAt = this.now();
  }

  /** Pushes one more commit onto the pull request's branch. */
  push(pull: SimPull, files: FileChanges, message = "update"): string {
    const sha = this.commit(this.repo(pull.repo), pull.headSha, files, message);
    this.moveHead(pull, sha);
    return sha;
  }

  /** Rewrites the branch: one new commit of `files` straight on the current
   * base, so the old head is no longer on the branch. */
  forcePush(pull: SimPull, files: FileChanges, message = "rewrite"): string {
    const repo = this.repo(pull.repo);
    const sha = this.commit(repo, this.sha(repo, pull.baseRef), files, message);
    this.moveHead(pull, sha);
    return sha;
  }

  close(pull: SimPull): void {
    pull.state = "closed";
    pull.closedAt = this.now();
    pull.updatedAt = pull.closedAt;
  }

  reopen(pull: SimPull): void {
    pull.state = "open";
    pull.closedAt = null;
    pull.updatedAt = this.now();
  }

  /** Merges with a merge commit on the base branch. */
  merge(pull: SimPull): string {
    const repo = this.repo(pull.repo);
    const base = this.sha(repo, pull.baseRef);
    const tree = this.git(repo, [
      "merge-tree",
      "--write-tree",
      base,
      pull.headSha,
    ])
      .split("\n")[0]!
      .trim();
    const sha = this.git(repo, [
      "commit-tree",
      tree,
      "-p",
      base,
      "-p",
      pull.headSha,
      "-m",
      `Merge pull request #${pull.number}`,
    ]).trim();
    this.setRef(repo, `refs/heads/${pull.baseRef}`, sha);
    this.git(repo, ["reset", "-q", "--hard", pull.baseRef]);
    pull.mergeCommitSha = sha;
    pull.mergedAt = this.now();
    this.close(pull);
    return sha;
  }

  /** A commit straight onto the default branch, as a push to it. */
  commitToDefault(
    repoName: string,
    files: FileChanges,
    message = "direct push",
  ): { before: string; after: string } {
    const repo = this.repo(repoName);
    const before = this.sha(repo, repo.defaultBranch);
    const after = this.commit(repo, before, files, message);
    this.setRef(repo, `refs/heads/${repo.defaultBranch}`, after);
    this.git(repo, ["reset", "-q", "--hard", repo.defaultBranch]);
    return { before, after };
  }

  /** A person comments on the pull request's conversation. Not a product
   * write, so it is not in `writes`. */
  comment(
    pull: SimPull,
    body: string,
    user = "sim-maintainer",
    association = "MEMBER",
  ): SimComment {
    const at = this.now();
    const comment: SimComment = {
      id: this.id(),
      repo: pull.repo,
      number: pull.number,
      kind: "issue",
      body,
      user: { login: user, type: "User" },
      association,
      createdAt: at,
      updatedAt: at,
    };
    this.comments.push(comment);
    return comment;
  }

  /** A person comments on a diff line, or replies to a line comment. */
  reviewComment(
    pull: SimPull,
    input: {
      body: string;
      path?: string;
      line?: number;
      inReplyTo?: number;
      user?: string;
      association?: string;
    },
  ): SimComment {
    const parent = input.inReplyTo
      ? this.comments.find((comment) => comment.id === input.inReplyTo)
      : undefined;
    const at = this.now();
    const comment: SimComment = {
      id: this.id(),
      repo: pull.repo,
      number: pull.number,
      kind: "review",
      body: input.body,
      user: { login: input.user ?? "sim-maintainer", type: "User" },
      association: input.association ?? "MEMBER",
      path: input.path ?? parent?.path,
      line: input.line ?? parent?.line,
      side: "RIGHT",
      commitId: pull.headSha,
      inReplyTo: input.inReplyTo,
      createdAt: at,
      updatedAt: at,
    };
    this.comments.push(comment);
    return comment;
  }

  findPull(repo: string, number: number): SimPull | undefined {
    return this.pulls.find(
      (pull) => pull.repo === repo && pull.number === number,
    );
  }

  /** Writes whose path matches, in order. */
  writesTo(path: RegExp, method?: string): GithubWrite[] {
    return this.writes.filter(
      (write) =>
        path.test(write.path) &&
        (method === undefined || write.method === method),
    );
  }

  // JSON shapes, as GitHub's REST API returns them.

  repoJson(repo: SimRepo): Json {
    const [owner, name] = repo.fullName.split("/");
    return {
      id: 1,
      name,
      full_name: repo.fullName,
      owner: { login: owner, type: "User" },
      private: false,
      fork: false,
      default_branch: repo.defaultBranch,
      description: "A repository simulated by e2e:simulate",
      html_url: `https://github.com/${repo.fullName}`,
      clone_url: `https://github.com/${repo.fullName}.git`,
    };
  }

  private diffStats(repo: SimRepo, base: string, head: string) {
    const files = this.files(repo, base, head);
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    return { files, additions, deletions };
  }

  private mergeBase(repo: SimRepo, base: string, head: string): string {
    return this.git(repo, ["merge-base", base, head]).trim();
  }

  /** Where a pull request's diff starts. Once merged, the base branch holds
   * the head, so the diff is taken against the base as it was at the merge,
   * the way GitHub keeps a merged pull request's files. */
  private diffBase(repo: SimRepo, pull: SimPull): string {
    const base = pull.mergeCommitSha
      ? this.sha(repo, `${pull.mergeCommitSha}^1`)
      : this.sha(repo, pull.baseRef);
    return this.mergeBase(repo, base, pull.headSha);
  }

  pullJson(pull: SimPull): Json {
    const repo = this.repo(pull.repo);
    const baseSha = this.sha(repo, pull.baseRef);
    const diffBase = this.diffBase(repo, pull);
    const stats = this.diffStats(repo, diffBase, pull.headSha);
    const [, name] = pull.repo.split("/");
    const headRepo = pull.fork ? `${pull.author}/${name}` : pull.repo;
    return {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      draft: pull.draft,
      locked: false,
      user: { login: pull.author, type: "User" },
      author_association: pull.association,
      labels: pull.labels.map((label) => ({ name: label })),
      head: {
        ref: pull.headRef,
        sha: pull.headSha,
        label: `${headRepo.split("/")[0]}:${pull.headRef}`,
        repo: { full_name: headRepo, fork: pull.fork },
      },
      base: {
        ref: pull.baseRef,
        sha: baseSha,
        repo: { full_name: pull.repo, fork: false },
      },
      merged: pull.mergedAt !== null,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      mergeable: pull.state === "open",
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
      closed_at: pull.closedAt,
      additions: stats.additions,
      deletions: stats.deletions,
      changed_files: stats.files.length,
      commits: Number(
        this.git(repo, [
          "rev-list",
          "--count",
          `${diffBase}..${pull.headSha}`,
        ]).trim(),
      ),
      html_url: `https://github.com/${pull.repo}/pull/${pull.number}`,
    };
  }

  /** GitHub's per-file listing of a diff, from `git diff`. `patch` starts at
   * the first hunk, without the diff header, as GitHub sends it, and is left
   * out the way GitHub leaves it out: for a binary file, a rename with no
   * change, and a diff too large to show (`MAX_PATCH_LINES`). */
  files(repo: SimRepo, base: string, head: string) {
    const status = this.git(repo, ["diff", "--name-status", "-M", base, head])
      .split("\n")
      .filter(Boolean);
    return status.map((line) => {
      const [code, first, second] = line.split("\t");
      const path = second ?? first!;
      const patchText = this.git(repo, [
        "diff",
        "--unified=3",
        "-M",
        base,
        head,
        "--",
        ...(second ? [first!, second] : [path]),
      ]);
      const patch = patchText.split("\n");
      const start = patch.findIndex((l) => l.startsWith("@@"));
      const body =
        start === -1 ? "" : patch.slice(start).join("\n").replace(/\n$/, "");
      const lines = body.split("\n");
      const additions = lines.filter((l) => l.startsWith("+")).length;
      const deletions = lines.filter((l) => l.startsWith("-")).length;
      return {
        sha: head,
        filename: path,
        ...(second ? { previous_filename: first } : {}),
        status: code!.startsWith("A")
          ? "added"
          : code!.startsWith("D")
            ? "removed"
            : code!.startsWith("R")
              ? "renamed"
              : "modified",
        additions,
        deletions,
        changes: additions + deletions,
        ...(body && lines.length <= MAX_PATCH_LINES ? { patch: body } : {}),
      };
    });
  }

  /** Line numbers a review comment may sit on in one file of a diff: on the
   * RIGHT side the new file's added and context lines, on the LEFT the old
   * file's removed and context lines. */
  private commentableLines(
    repo: SimRepo,
    base: string,
    head: string,
    path: string,
    side: string,
  ): Set<number> {
    const file = this.files(repo, base, head).find((f) => f.filename === path);
    const lines = new Set<number>();
    let oldLine = 0;
    let newLine = 0;
    for (const line of (file?.patch ?? "").split("\n")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        continue;
      }
      if (line.startsWith("+")) {
        if (side === "RIGHT") lines.add(newLine);
        newLine++;
      } else if (line.startsWith("-")) {
        if (side === "LEFT") lines.add(oldLine);
        oldLine++;
      } else if (!line.startsWith("\\")) {
        lines.add(side === "RIGHT" ? newLine : oldLine);
        oldLine++;
        newLine++;
      }
    }
    return lines;
  }

  /** GitHub's 422 for a review comment it cannot place: its line, or its
   * first line, is not in the diff of that file at that commit. */
  private unplaceable(
    repo: SimRepo,
    pull: SimPull,
    comment: Json,
  ): RouteResult | undefined {
    let commit = pull.headSha;
    try {
      if (typeof comment.commit_id === "string") {
        commit = this.sha(repo, `${comment.commit_id}^{commit}`);
      }
    } catch {
      return {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: ["commit_id is not part of the pull request"],
        },
      };
    }
    const base = this.mergeBase(
      repo,
      pull.mergeCommitSha
        ? this.sha(repo, `${pull.mergeCommitSha}^1`)
        : this.sha(repo, pull.baseRef),
      commit,
    );
    const path = String(comment.path ?? "");
    const wanted = [
      [asNumber(comment.line), String(comment.side ?? "RIGHT")],
      [
        asNumber(comment.start_line),
        String(comment.start_side ?? comment.side ?? "RIGHT"),
      ],
    ] as const;
    if (wanted[0][0] === undefined) {
      return {
        status: 422,
        body: { message: "Validation Failed", errors: ["line is required"] },
      };
    }
    for (const [line, side] of wanted) {
      if (line === undefined) continue;
      if (!this.commentableLines(repo, base, commit, path, side).has(line)) {
        return {
          status: 422,
          body: {
            message: "Unprocessable Entity",
            errors: ["Line could not be resolved"],
          },
        };
      }
    }
    return undefined;
  }

  private commitJson(repo: SimRepo, sha: string): Json {
    const [full, parents, name, email, date, ...message] = this.git(repo, [
      "show",
      "-s",
      "--format=%H%n%P%n%an%n%ae%n%aI%n%B",
      sha,
    ]).split("\n");
    return {
      sha: full,
      commit: {
        message: message.join("\n").trim(),
        author: { name, email, date },
        committer: { name, email, date },
      },
      author: { login: name?.replaceAll(" ", "-") ?? "" },
      parents: (parents ?? "")
        .split(" ")
        .filter(Boolean)
        .map((parent) => ({ sha: parent })),
      html_url: `https://github.com/${repo.fullName}/commit/${full}`,
    };
  }

  commentJson(comment: SimComment): Json {
    const common = {
      id: comment.id,
      node_id: `C_${comment.id}`,
      body: comment.body,
      user: comment.user,
      author_association: comment.association,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    };
    if (comment.kind === "issue") {
      return {
        ...common,
        html_url: `https://github.com/${comment.repo}/pull/${comment.number}#issuecomment-${comment.id}`,
      };
    }
    return {
      ...common,
      path: comment.path,
      line: comment.line ?? null,
      original_line: comment.line ?? null,
      start_line: comment.startLine ?? null,
      side: comment.side ?? "RIGHT",
      commit_id: comment.commitId,
      original_commit_id: comment.commitId,
      in_reply_to_id: comment.inReplyTo,
      pull_request_review_id: comment.reviewId ?? null,
      html_url: `https://github.com/${comment.repo}/pull/${comment.number}#discussion_r${comment.id}`,
    };
  }

  private reviewJson(review: SimReview): Json {
    return {
      id: review.id,
      body: review.body,
      state: review.state,
      user: review.user,
      commit_id: review.commitId,
      submitted_at: review.submittedAt,
      html_url: `https://github.com/${review.repo}/pull/${review.number}#pullrequestreview-${review.id}`,
    };
  }

  private checkRunJson(run: SimCheckRun): Json {
    return {
      id: run.id,
      name: run.name,
      head_sha: run.headSha,
      status: run.status,
      conclusion: run.conclusion,
      output: run.output,
    };
  }

  private issueJson(issue: SimIssue): Json {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name })),
      user: issue.user,
      closed_by: issue.closedBy,
      html_url: `https://github.com/${issue.repo}/issues/${issue.number}`,
    };
  }

  /** GitHub's paging: 30 by default, never more than 100 a page. */
  private page<T>(items: T[], url: URL): T[] {
    const perPage = Math.min(
      asNumber(url.searchParams.get("per_page")) ?? 30,
      100,
    );
    const page = asNumber(url.searchParams.get("page")) ?? 1;
    return items.slice((page - 1) * perPage, page * perPage);
  }

  /** Answers one REST call. `undefined` means no route: the caller answers
   * 404 and marks the call unhandled. */
  route(request: RouteRequest): RouteResult | undefined {
    const result = this.authenticate(request) ?? this.answer(request);
    const method = request.method;
    const path = request.url.pathname.replace(/^\/+/, "");
    // Minting an installation token changes nothing anyone can see.
    if (
      result &&
      method !== "GET" &&
      method !== "HEAD" &&
      !/^app\/installations\/\d+\/access_tokens$/.test(path)
    ) {
      const id = asNumber((result.body as Json | null)?.id);
      this.writes.push({
        seq: this.writes.length + 1,
        step: request.step,
        method,
        path,
        body: request.body,
        status: result.status,
        ...(id === undefined ? {} : { id }),
        via: request.via,
        actor: this.actor(request).login,
      });
    }
    return result;
  }

  /** GitHub's answer to a request it does not accept the credentials of, or
   * undefined when it does. `gh` carries its own login, so a call through it
   * is the person. Without a token GitHub still answers a read of a public
   * repository. The App's own routes take only a JWT the App's key signed,
   * every other route the world's token or an installation token this
   * GitHub minted. */
  private authenticate(request: RouteRequest): RouteResult | undefined {
    if (request.via === "gh") return undefined;
    const path = request.url.pathname.replace(/^\/+/, "");
    const appRoute = /^app(\/|$)/.test(path);
    const token = request.token;
    const refuse = (message: string): RouteResult => ({
      status: 401,
      body: { message },
    });
    if (token === undefined) {
      return request.method === "GET" && !appRoute
        ? undefined
        : refuse("Requires authentication");
    }
    if (appRoute) {
      return this.validJwt(token)
        ? undefined
        : refuse("A JSON web token could not be decoded");
    }
    if (token === this.world.secrets.pat || this.tokens.has(token)) {
      return undefined;
    }
    return refuse("Bad credentials");
  }

  /** A JWT signed with the App's private key, issued for the App. */
  private validJwt(token: string): boolean {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    try {
      const key = createPublicKey(
        createPrivateKey(this.world.secrets.appPrivateKey),
      );
      const signed = verify(
        "sha256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        key,
        Buffer.from(parts[2]!, "base64url"),
      );
      const claims = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString(),
      ) as { iss?: unknown };
      return signed && String(claims.iss) === this.world.secrets.appId;
    } catch {
      return false;
    }
  }

  /** An installation token (`ghs_`) is the App, anything else a person. */
  private actor(request: RouteRequest): SimUser {
    return request.token?.startsWith("ghs_") ? this.bot : this.tokenUser;
  }

  private answer(request: RouteRequest): RouteResult | undefined {
    const { method, url } = request;
    const path = url.pathname.replace(/^\/+/, "");
    const body = (request.body ?? {}) as Json;

    if (method === "GET" && path === "rate_limit") {
      const reset = Math.floor(Date.now() / 1000) + 3600;
      const row = { limit: 5000, remaining: 4999, reset, used: 1 };
      return ok({ resources: { core: row, search: row }, rate: row });
    }
    if (method === "GET" && path === "user") {
      return ok({ login: this.tokenUser.login, type: "User" });
    }
    if (method === "GET" && path === "app/installations") {
      return ok([this.installationJson()]);
    }
    const tokenMatch = /^app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (method === "POST" && tokenMatch) {
      if (Number(tokenMatch[1]) !== this.installation.id) return notFound();
      const token = `ghs_sim${randomBytes(12).toString("hex")}`;
      this.tokens.add(token);
      // A real installation token is a secret, so the leak check holds it to
      // GitHub too.
      this.world.addSecret(`installation token ${this.tokens.size}`, token, [
        "api.github.com",
      ]);
      return ok(
        {
          token,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        201,
      );
    }
    if (method === "GET" && path === "installation/repositories") {
      const repositories = [...this.world.repos.values()].map((repo) => ({
        full_name: repo.fullName,
        private: false,
      }));
      return ok({ total_count: repositories.length, repositories });
    }
    if (method === "GET" && path === "search/issues") {
      return ok({ total_count: 0, incomplete_results: false, items: [] });
    }

    const match = /^repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    const fullName = match ? decodeURIComponent(match[1]!) : undefined;
    const repo = [...this.world.repos.values()].find(
      (candidate) =>
        candidate.fullName.toLowerCase() === fullName?.toLowerCase(),
    );
    if (!match || !repo) return undefined;
    return this.repoRoute(request, repo, match[2] ?? "", body);
  }

  private installationJson(): Json {
    return {
      id: this.installation.id,
      account: { login: this.installation.account, type: "User" },
      suspended_at: null,
      permissions: this.installation.permissions,
      events: this.installation.events,
    };
  }

  private repoRoute(
    request: RouteRequest,
    repo: SimRepo,
    rest: string,
    body: Json,
  ): RouteResult | undefined {
    const { method, url } = request;
    const name = repo.fullName;
    const get = method === "GET";
    let m: RegExpExecArray | null;

    if (get && rest === "") return ok(this.repoJson(repo));
    if (get && rest === "/installation") return ok(this.installationJson());

    if (get && (m = /^\/git\/trees\/(.+)$/.exec(rest))) {
      const ref = decodeURIComponent(m[1]!);
      let listing: string;
      try {
        listing = this.git(repo, ["ls-tree", "-r", "-l", "--full-tree", ref]);
      } catch {
        return notFound();
      }
      const tree = listing
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [meta, path] = line.split("\t");
          const [mode, type, sha, size] = meta!.split(/\s+/);
          return { path, mode, type, sha, size: asNumber(size) };
        });
      return ok({ sha: this.sha(repo, ref), truncated: false, tree });
    }

    if (get && (m = /^\/contents\/(.+)$/.exec(rest))) {
      const path = m[1]!.split("/").map(decodeURIComponent).join("/");
      const ref = url.searchParams.get("ref") ?? repo.defaultBranch;
      try {
        const content = this.world.git(repo, ["show", `${ref}:${path}`]);
        return ok({
          type: "file",
          path,
          name: path.split("/").pop(),
          encoding: "base64",
          size: content.length,
          content: content.toString("base64"),
        });
      } catch {
        return notFound();
      }
    }

    if (get && rest === "/commits") {
      const sha = url.searchParams.get("sha") ?? repo.defaultBranch;
      const file = url.searchParams.get("path");
      let shas: string[];
      try {
        shas = this.git(repo, [
          "log",
          "--format=%H",
          sha,
          ...(file ? ["--", file] : []),
        ])
          .split("\n")
          .filter(Boolean);
      } catch {
        return notFound();
      }
      return ok(this.page(shas, url).map((s) => this.commitJson(repo, s)));
    }

    if (get && (m = /^\/commits\/([^/]+)$/.exec(rest))) {
      const sha = decodeURIComponent(m[1]!);
      try {
        const commit = this.commitJson(repo, sha);
        const parent = (commit.parents as { sha: string }[])[0]?.sha;
        return ok({
          ...commit,
          files: parent ? this.files(repo, parent, String(commit.sha)) : [],
        });
      } catch {
        return notFound();
      }
    }

    if (get && (m = /^\/commits\/([^/]+)\/check-runs$/.exec(rest))) {
      const sha = decodeURIComponent(m[1]!);
      const runs = this.checkRuns.filter(
        (run) => run.repo === name && run.headSha === sha,
      );
      return ok({
        total_count: runs.length,
        check_runs: runs.map((run) => this.checkRunJson(run)),
      });
    }

    if (get && (m = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest))) {
      const base = decodeURIComponent(m[1]!);
      const head = decodeURIComponent(m[2]!);
      let mergeBase: string;
      try {
        mergeBase = this.mergeBase(repo, base, head);
      } catch {
        return notFound();
      }
      const commits = this.git(repo, [
        "rev-list",
        "--reverse",
        `${mergeBase}..${head}`,
      ])
        .split("\n")
        .filter(Boolean);
      const behind = Number(
        this.git(repo, ["rev-list", "--count", `${mergeBase}..${base}`]).trim(),
      );
      return ok({
        status:
          commits.length && behind
            ? "diverged"
            : commits.length
              ? "ahead"
              : behind
                ? "behind"
                : "identical",
        ahead_by: commits.length,
        behind_by: behind,
        total_commits: commits.length,
        base_commit: this.commitJson(repo, base),
        merge_base_commit: this.commitJson(repo, mergeBase),
        commits: commits
          .slice(0, MAX_COMPARE_COMMITS)
          .map((sha) => this.commitJson(repo, sha)),
        files: this.files(repo, mergeBase, head).slice(0, MAX_COMPARE_FILES),
      });
    }

    if (get && rest === "/releases") return ok([]);
    if (get && rest === "/labels") {
      return ok(
        [...(this.labels.get(name) ?? [])].map((label) => ({ name: label })),
      );
    }

    if (get && (m = /^\/collaborators\/([^/]+)\/permission$/.exec(rest))) {
      const role = this.readOnly.has(decodeURIComponent(m[1]!))
        ? "read"
        : "write";
      return ok({ permission: role, role_name: role });
    }

    if (get && rest === "/pulls") {
      const state = url.searchParams.get("state") ?? "open";
      const pulls = this.pulls
        .filter(
          (pull) =>
            pull.repo === name && (state === "all" || pull.state === state),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return ok(this.page(pulls, url).map((pull) => this.pullJson(pull)));
    }

    if ((m = /^\/pulls\/(\d+)(\/.*)?$/.exec(rest))) {
      const pull = this.findPull(name, Number(m[1]));
      if (!pull) return notFound();
      return this.pullRoute(request, repo, pull, m[2] ?? "", body);
    }

    if (method === "PATCH" && (m = /^\/pulls\/comments\/(\d+)$/.exec(rest))) {
      return this.editComment(Number(m[1]), body, "review");
    }

    if (
      method === "POST" &&
      (m = /^\/pulls\/comments\/(\d+)\/reactions$/.exec(rest))
    ) {
      return this.react(request, body);
    }

    if ((m = /^\/issues\/comments\/(\d+)(\/reactions)?$/.exec(rest))) {
      if (m[2] && method === "POST") return this.react(request, body);
      const id = Number(m[1]);
      if (get) {
        const comment = this.comments.find(
          (c) => c.id === id && c.kind === "issue",
        );
        return comment ? ok(this.commentJson(comment)) : notFound();
      }
      if (method === "PATCH") return this.editComment(id, body, "issue");
      return undefined;
    }

    if (method === "POST" && rest === "/issues") {
      const issue: SimIssue = {
        repo: name,
        number: this.nextNumber(name),
        title: String(body.title ?? ""),
        body: String(body.body ?? ""),
        labels: Array.isArray(body.labels) ? body.labels.map(String) : [],
        state: "open",
        closedBy: null,
        user: this.actor(request),
      };
      this.issues.push(issue);
      return ok({ ...this.issueJson(issue), id: this.id() }, 201);
    }

    if (method === "POST" && rest === "/labels") {
      const labels = this.labels.get(name) ?? new Set<string>();
      this.labels.set(name, labels);
      const label = String(body.name ?? "");
      if (labels.has(label)) return ok({ message: "Validation Failed" }, 422);
      labels.add(label);
      return ok({ name: label }, 201);
    }

    if ((m = /^\/issues\/(\d+)(\/.*)?$/.exec(rest))) {
      return this.issueRoute(request, name, Number(m[1]), m[2] ?? "", body);
    }

    // Check runs belong to GitHub Apps. A person's token, `gh` included, is
    // refused.
    if (
      (rest === "/check-runs" || /^\/check-runs\/\d+$/.test(rest)) &&
      !get &&
      (request.via === "gh" || !request.token?.startsWith("ghs_"))
    ) {
      return {
        status: 403,
        body: { message: "You must authenticate via a GitHub App." },
      };
    }

    if (method === "POST" && rest === "/check-runs") {
      const run: SimCheckRun = {
        id: this.id(),
        repo: name,
        name: String(body.name ?? ""),
        headSha: String(body.head_sha ?? ""),
        status: String(body.status ?? "queued"),
        conclusion:
          typeof body.conclusion === "string" ? body.conclusion : null,
        output: (body.output as Json | undefined) ?? null,
        updates: [body],
      };
      this.checkRuns.push(run);
      return ok(this.checkRunJson(run), 201);
    }

    if ((m = /^\/check-runs\/(\d+)$/.exec(rest))) {
      const run = this.checkRuns.find(
        (candidate) =>
          candidate.id === Number(m![1]) && candidate.repo === name,
      );
      if (!run) return notFound();
      if (get) return ok(this.checkRunJson(run));
      if (method !== "PATCH") return undefined;
      if (typeof body.status === "string") run.status = body.status;
      if (typeof body.conclusion === "string") {
        run.conclusion = body.conclusion;
        run.status = "completed";
      }
      if (body.output) run.output = body.output as Json;
      if (typeof body.name === "string") run.name = body.name;
      run.updates.push(body);
      return ok(this.checkRunJson(run));
    }

    return undefined;
  }

  private pullRoute(
    request: RouteRequest,
    repo: SimRepo,
    pull: SimPull,
    rest: string,
    body: Json,
  ): RouteResult | undefined {
    const { method, url } = request;
    const get = method === "GET";
    let m: RegExpExecArray | null;
    if (get && rest === "") return ok(this.pullJson(pull));
    if (get && rest === "/files") {
      const base = this.diffBase(repo, pull);
      return ok(
        this.page(
          this.files(repo, base, pull.headSha).slice(0, MAX_PULL_FILES),
          url,
        ),
      );
    }
    if (get && rest === "/commits") {
      const base = this.diffBase(repo, pull);
      const shas = this.git(repo, [
        "rev-list",
        "--reverse",
        `${base}..${pull.headSha}`,
      ])
        .split("\n")
        .filter(Boolean);
      return ok(this.page(shas, url).map((sha) => this.commitJson(repo, sha)));
    }
    if (rest === "/comments") {
      if (get) {
        return ok(
          this.page(this.listComments(pull, "review"), url).map((comment) =>
            this.commentJson(comment),
          ),
        );
      }
      if (method === "POST") {
        const parent =
          body.in_reply_to === undefined
            ? undefined
            : this.comments.find((c) => c.id === asNumber(body.in_reply_to));
        if (body.in_reply_to !== undefined && !parent) return notFound();
        const refused = parent ? undefined : this.unplaceable(repo, pull, body);
        if (refused) return refused;
        const comment = this.addComment(request, pull, "review", body, parent);
        return ok(this.commentJson(comment), 201);
      }
      return undefined;
    }
    if (method === "POST" && (m = /^\/comments\/(\d+)\/replies$/.exec(rest))) {
      const parent = this.comments.find((c) => c.id === Number(m![1]));
      if (!parent || parent.kind !== "review") return notFound();
      const comment = this.addComment(request, pull, "review", body, parent);
      return ok(this.commentJson(comment), 201);
    }
    if (rest === "/reviews") {
      if (get) {
        const reviews = this.reviews.filter(
          (review) =>
            review.repo === pull.repo && review.number === pull.number,
        );
        return ok(this.page(reviews, url).map((r) => this.reviewJson(r)));
      }
      if (method === "POST") {
        // One comment GitHub cannot place rejects the whole review.
        const inline = Array.isArray(body.comments)
          ? (body.comments as Json[])
          : [];
        for (const item of inline) {
          const refused = this.unplaceable(repo, pull, {
            ...item,
            commit_id: body.commit_id,
          });
          if (refused) return refused;
        }
        const event = String(body.event ?? "");
        if (
          (event === "COMMENT" || event === "REQUEST_CHANGES") &&
          !String(body.body ?? "").trim() &&
          inline.length === 0
        ) {
          return {
            status: 422,
            body: {
              message: "Unprocessable Entity",
              errors: ["Review body is required"],
            },
          };
        }
        const review: SimReview = {
          id: this.id(),
          repo: pull.repo,
          number: pull.number,
          body: String(body.body ?? ""),
          state:
            body.event === "APPROVE"
              ? "APPROVED"
              : body.event === "REQUEST_CHANGES"
                ? "CHANGES_REQUESTED"
                : body.event === "COMMENT"
                  ? "COMMENTED"
                  : "PENDING",
          user: this.actor(request),
          commitId: String(body.commit_id ?? pull.headSha),
          submittedAt: this.now(),
        };
        this.reviews.push(review);
        for (const item of inline) {
          const comment = this.addComment(request, pull, "review", {
            ...item,
            commit_id: review.commitId,
          });
          comment.reviewId = review.id;
        }
        return ok(this.reviewJson(review));
      }
      return undefined;
    }
    if (get && (m = /^\/reviews\/(\d+)\/comments$/.exec(rest))) {
      const id = Number(m[1]);
      return ok(
        this.comments
          .filter((comment) => comment.reviewId === id)
          .map((comment) => this.commentJson(comment)),
      );
    }
    return undefined;
  }

  private issueRoute(
    request: RouteRequest,
    name: string,
    number: number,
    rest: string,
    body: Json,
  ): RouteResult | undefined {
    const { method, url } = request;
    const pull = this.findPull(name, number);
    const issue = this.issues.find(
      (candidate) => candidate.repo === name && candidate.number === number,
    );
    if (!pull && !issue) return notFound();
    if (rest === "/comments") {
      if (method === "GET") {
        const comments = this.comments.filter(
          (c) => c.repo === name && c.number === number && c.kind === "issue",
        );
        return ok(this.page(comments, url).map((c) => this.commentJson(c)));
      }
      if (method === "POST") {
        const target = pull ?? { repo: name, number, headSha: "" };
        const comment = this.addComment(request, target, "issue", body);
        return ok(this.commentJson(comment), 201);
      }
      return undefined;
    }
    if (rest === "/reactions" && method === "POST") {
      return this.react(request, body);
    }
    if (rest === "/labels" && method === "POST") {
      const labels = Array.isArray(body.labels) ? body.labels.map(String) : [];
      if (pull) pull.labels.push(...labels);
      if (issue) issue.labels.push(...labels);
      return ok(labels.map((label) => ({ name: label })));
    }
    if (rest !== "") return undefined;
    if (method === "GET") {
      if (issue) return ok(this.issueJson(issue));
      const json = this.pullJson(pull!);
      return ok({ ...json, pull_request: { url: json.html_url } });
    }
    if (method === "PATCH") {
      if (issue) {
        if (body.state === "closed") {
          issue.state = "closed";
          issue.closedBy = this.actor(request);
        } else if (body.state === "open") {
          issue.state = "open";
          issue.closedBy = null;
        }
        if (typeof body.body === "string") issue.body = body.body;
        if (typeof body.title === "string") issue.title = body.title;
        return ok(this.issueJson(issue));
      }
      if (body.state === "closed") this.close(pull!);
      return ok(this.pullJson(pull!));
    }
    return undefined;
  }

  private listComments(pull: SimPull, kind: SimComment["kind"]): SimComment[] {
    return this.comments.filter(
      (comment) =>
        comment.repo === pull.repo &&
        comment.number === pull.number &&
        comment.kind === kind,
    );
  }

  private addComment(
    request: RouteRequest,
    pull: { repo: string; number: number; headSha: string },
    kind: SimComment["kind"],
    body: Json,
    parent?: SimComment,
  ): SimComment {
    const at = this.now();
    const comment: SimComment = {
      id: this.id(),
      repo: pull.repo,
      number: pull.number,
      kind,
      body: String(body.body ?? ""),
      user: this.actor(request),
      association: "NONE",
      createdAt: at,
      updatedAt: at,
    };
    if (kind === "review") {
      comment.path = parent?.path ?? String(body.path ?? "");
      comment.line = parent?.line ?? asNumber(body.line);
      comment.startLine = asNumber(body.start_line);
      comment.side = String(body.side ?? parent?.side ?? "RIGHT");
      comment.commitId = String(
        body.commit_id ?? parent?.commitId ?? pull.headSha,
      );
      if (parent) comment.inReplyTo = parent.inReplyTo ?? parent.id;
    }
    this.comments.push(comment);
    return comment;
  }

  private editComment(
    id: number,
    body: Json,
    kind: SimComment["kind"],
  ): RouteResult {
    const comment = this.comments.find((c) => c.id === id && c.kind === kind);
    if (!comment) return notFound();
    if (typeof body.body === "string") comment.body = body.body;
    comment.updatedAt = this.now();
    return ok(this.commentJson(comment));
  }

  private react(request: RouteRequest, body: Json): RouteResult {
    const content = String(body.content ?? "");
    this.reactions.push({
      path: request.url.pathname.replace(/^\/+/, ""),
      content,
    });
    return ok({ id: this.id(), content }, 201);
  }
}
