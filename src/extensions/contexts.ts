/** The `details.json` context of each review type, built from what that
 * review already has in hand. Keeping them here leaves each review mode one
 * call to make. */
import type { GitHubClient, Json } from "../types.ts";
import type { Revision } from "../review/revision.ts";
import { unifiedDiff, type DiffFile, type ReviewContext } from "./session.ts";
import { localTracking } from "./local_tracking.ts";

/** GitHub's file list as diff files. */
export function githubDiffFiles(files: Json[]): DiffFile[] {
  return files.map((file) => ({
    path: String(file.filename ?? ""),
    previousPath:
      typeof file.previous_filename === "string"
        ? file.previous_filename
        : null,
    status: String(file.status ?? "modified"),
    patch: String(file.patch ?? ""),
  }));
}

/** A local review: the command runs in the checkout. */
export function localContext(input: {
  repo: string;
  branch: string;
  root: string;
  headSha: string;
  baseSha: string;
  revision: Revision;
  /** `--fresh` starts the extension findings over too. */
  fresh: boolean;
}): ReviewContext {
  return {
    tracking: localTracking({
      repo: input.repo,
      root: input.root,
      branch: input.branch,
      fresh: input.fresh,
    }),
    owner: "cli",
    reviewType: "local",
    repo: input.repo,
    prNumber: null,
    branch: input.branch,
    workdir: input.root,
    headSha: input.headSha,
    baseSha: input.baseSha,
    scope: "workspace",
    sinceCommit: null,
    trigger: "cli",
    round: 1,
    diff: () => unifiedDiff(input.revision.files),
  };
}

/** A pull request reviewed from the CLI. The pull request and its files are
 * read only when an extension is going to run. */
export function cliPrContext(input: {
  client: GitHubClient;
  repo: string;
  prNumber: number;
  /** What the carry-over code already read, so nothing is read twice. */
  prefetched?: { pull: Json; files: Json[] };
}): ReviewContext {
  const context: ReviewContext = {
    owner: "cli",
    reviewType: "pr",
    repo: input.repo,
    prNumber: input.prNumber,
    branch: null,
    workdir: "",
    headSha: null,
    baseSha: null,
    scope: "whole-pr",
    sinceCommit: null,
    trigger: "cli",
    round: 1,
    diff: async () => {
      const [pr, files] = input.prefetched
        ? [input.prefetched.pull, input.prefetched.files]
        : await Promise.all([
            input.client.request<Json>(
              `repos/${input.repo}/pulls/${input.prNumber}`,
            ),
            input.client.pages<Json>(
              `repos/${input.repo}/pulls/${input.prNumber}/files`,
            ),
          ]);
      // The shas come with the same request, and details.json is written
      // after the diff, so they are filled in here.
      context.headSha =
        String((pr.head as Json | undefined)?.sha ?? "") || null;
      context.baseSha =
        String((pr.base as Json | undefined)?.sha ?? "") || null;
      context.branch = String((pr.head as Json | undefined)?.ref ?? "") || null;
      return unifiedDiff(githubDiffFiles(files));
    },
  };
  return context;
}

/** A pull request reviewed by `serve` as the GitHub App. The job id is the run
 * id, so a rerun after a restart finds its folder. */
export function appPrContext(input: {
  jobId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  branch: string | null;
  scope: string;
  sinceCommit: string | null;
  trigger: string;
  round: number;
  files: Json[];
  log?: (message: string) => void;
}): ReviewContext {
  return {
    runId: input.jobId,
    owner: "serve",
    reviewType: "pr",
    repo: input.repo,
    prNumber: input.prNumber,
    branch: input.branch,
    workdir: "",
    headSha: input.headSha || null,
    baseSha: input.baseSha || null,
    scope: input.scope,
    sinceCommit: input.sinceCommit,
    trigger: input.trigger,
    round: input.round,
    diff: () => unifiedDiff(githubDiffFiles(input.files)),
    log: input.log,
  };
}

/** A remote review: `serve` runs its own registrations on the client's diff.
 * The client's checkout is on another machine, so there is no workdir. */
export function remoteContext(input: {
  jobId: string;
  repo: string;
  branch: string | null;
  revision: Revision;
  round: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}): ReviewContext {
  return {
    runId: input.jobId,
    owner: "serve",
    reviewType: "remote",
    repo: input.repo,
    prNumber: null,
    branch: input.branch,
    workdir: "",
    headSha: null,
    baseSha: null,
    scope: "workspace",
    sinceCommit: null,
    trigger: "remote",
    round: input.round,
    diff: () => unifiedDiff(input.revision.files),
    signal: input.signal,
    log: input.log,
  };
}
