/** The reading half of `co-maintainer probe`, shared by the CLI and the
 * dashboard's Add repository preview.
 *
 * It only reads: no guide is written, nothing is cached here. The CLI adds
 * the estimate, the printing and `--run`, `/api/repos/preview` adds the
 * access check and returns the plan for confirmation. Keeping one
 * implementation means the number an operator confirms is the number `init`
 * would be given. */
import { analyzeProbe } from "../knowledge/probe.ts";
import type { ProbeResult } from "../knowledge/probe.ts";
import { importantCodebasePaths, withinPrWindow } from "../github/collect.ts";
import {
  agentInstructionsPattern,
  matchInstructionPaths,
} from "../knowledge/instruction_files.ts";
import type { GithubQuota } from "../ai/estimate.ts";
import {
  REVIEW_SAMPLE_SIZE,
  type ReviewSamplePull,
} from "../ai/review_estimate.ts";
import { timed } from "../util/log.ts";
import type { GitHubClient, Json } from "../types.ts";

export type ProbePlan = {
  analysis: ProbeResult;
  /** The `init` flags the analysis implies, in command order. */
  recommendation: string[];
  /** The whole `co-maintainer init owner/repo …` line. */
  command: string;
  /** The analysis report plus the recommendation and reasons, for storage. */
  report: Json;
  /** Every listed pull request's `updated_at`, newest first, so a window of
   * any length can be counted the way `init` counts it. */
  pullUpdatedAt: string[];
  /** The share of sampled diffs that fit the recommended change line cap. */
  changeShare: number;
  /** The newest pull requests a review would see, with their files. */
  reviewSample: ReviewSamplePull[];
  /** What the probe's own GitHub calls measured. */
  github: {
    calls: number;
    secondsPerCall: number;
    quota?: GithubQuota;
    /** The calls the codebase read would take: the tree, the instruction
     * files and the important files. Absent when the tree is unreadable. */
    codebaseCalls?: number;
  };
};

/** Pull requests updated in the last `months` months, as `init` counts them. */
export function pullRequestsInWindow(
  pullUpdatedAt: string[],
  months: number | undefined,
): number {
  return pullUpdatedAt.filter((updatedAt) => withinPrWindow(updatedAt, months))
    .length;
}

/** A pull request review runs on: not a bot's, not a draft, with changes.
 * The App skips drafts and bot authors (`app.ts`, `webhook.ts`). */
export function reviewable(detail: Json): boolean {
  const user = (detail.user ?? {}) as Json;
  const bot =
    String(user.type ?? "") === "Bot" ||
    String(user.login ?? "").endsWith("[bot]");
  const lines = Number(detail.additions ?? 0) + Number(detail.deletions ?? 0);
  return !bot && detail.draft !== true && lines > 0;
}

/** Counts the client's calls and how long they took. A paged read counts
 * each page. */
function measured(client: GitHubClient): {
  client: GitHubClient;
  stats: () => { calls: number; secondsPerCall: number };
} {
  let calls = 0;
  let seconds = 0;
  const wrapped: GitHubClient = {
    request: async <T>(endpoint: string): Promise<T> => {
      const started = performance.now();
      try {
        return await client.request<T>(endpoint);
      } finally {
        calls++;
        seconds += (performance.now() - started) / 1_000;
      }
    },
    pages: async <T>(
      endpoint: string,
      limit?: number,
      progress?: (page: number, fetched: number) => void,
    ): Promise<T[]> => {
      const started = performance.now();
      let pages = 0;
      try {
        return await client.pages<T>(endpoint, limit, (page, fetched) => {
          pages = page;
          progress?.(page, fetched);
        });
      } finally {
        calls += Math.max(1, pages);
        seconds += (performance.now() - started) / 1_000;
      }
    },
  };
  return {
    client: wrapped,
    stats: () => ({
      calls,
      secondsPerCall: calls > 0 ? seconds / calls : 0,
    }),
  };
}

/** The core quota from `/rate_limit`, which itself costs nothing. */
async function readQuota(
  client: GitHubClient,
): Promise<GithubQuota | undefined> {
  try {
    const body = await client.request<Json>("rate_limit");
    const core = ((body.resources ?? {}) as Json).core as Json | undefined;
    const limit = Number(core?.limit);
    const remaining = Number(core?.remaining);
    const reset = Number(core?.reset);
    if (![limit, remaining, reset].every(Number.isFinite)) return undefined;
    return { limit, remaining, resetAt: reset * 1_000 };
  } catch {
    return undefined;
  }
}

/** Samples this many pull requests for diff sizes, on top of a few per year. */
const SAMPLE_HEAD = 30;
const SAMPLE_PER_YEAR = 3;

export async function probePlan(
  githubClient: GitHubClient,
  repo: string,
  opts: {
    ghConcurrent: number;
    logTime?: boolean;
    log?: (message: string) => void;
  },
): Promise<ProbePlan> {
  const say = opts.log ?? (() => {});
  const { client, stats } = measured(githubClient);
  const timedRun = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
    timed(label, opts.logTime ?? false, fn);

  say(`reading ${repo} metadata`);
  const meta = await timedRun("probe repository metadata", () =>
    client.request<Json>(`repos/${repo}`),
  );

  let latestReleaseAt = "";
  try {
    const releases = await timedRun("probe release metadata", () =>
      client.pages<Json>(`repos/${repo}/releases?per_page=1`, 1),
    );
    latestReleaseAt = String(
      releases[0]?.published_at ?? releases[0]?.created_at ?? "",
    );
  } catch {
    // Release metadata is an optional probe signal.
  }

  say("reading pull request list");
  const pulls = await timedRun("probe pull request listing", () =>
    client.pages<Json>(
      `repos/${repo}/pulls?state=all&sort=updated&direction=desc`,
      undefined,
      (page, fetched) =>
        say(`pull request listing · page ${page} · fetched ${fetched}`),
    ),
  );

  const yearBuckets = new Map<number, Json[]>();
  for (const pull of pulls) {
    const pullYear = new Date(String(pull.updated_at)).getFullYear();
    yearBuckets.set(pullYear, [...(yearBuckets.get(pullYear) ?? []), pull]);
  }
  const sampleTargets = new Map<number, Json>();
  for (const pull of pulls.slice(0, SAMPLE_HEAD)) {
    sampleTargets.set(Number(pull.number), pull);
  }
  for (const yearPulls of yearBuckets.values()) {
    for (const pull of yearPulls.slice(0, SAMPLE_PER_YEAR)) {
      sampleTargets.set(Number(pull.number), pull);
    }
  }
  const samplePulls = [...sampleTargets.values()];

  const detailSamples: Json[] = [];
  say(
    `sampling ${samplePulls.length} pull request details · concurrency=${opts.ghConcurrent}`,
  );
  await timedRun("probe PR detail sampling", async () => {
    const details: (Json | undefined)[] = new Array(samplePulls.length);
    let cursor = 0;
    let completed = 0;
    const worker = async () => {
      while (cursor < samplePulls.length) {
        const index = cursor++;
        const pull = samplePulls[index];
        try {
          details[index] = await client.request<Json>(
            `repos/${repo}/pulls/${Number(pull.number)}`,
          );
        } catch {
          // A missing detail should not invalidate the rest of the probe.
        } finally {
          completed++;
          say(`PR detail sampling · ${completed}/${samplePulls.length}`);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(opts.ghConcurrent, samplePulls.length) },
        worker,
      ),
    );
    detailSamples.push(...details.filter((detail): detail is Json => !!detail));
  });

  const branch = String(meta.default_branch ?? "main");
  say(`sampled ${detailSamples.length} PR details · reading ${branch} commits`);
  const commits = await timedRun("probe commit history", () =>
    client.pages<Json>(
      `repos/${repo}/commits?sha=${encodeURIComponent(branch)}`,
      undefined,
      (page, fetched) =>
        say(`commit history · page ${page} · fetched ${fetched}`),
    ),
  );

  const analysis = await timedRun("probe analysis", async () =>
    analyzeProbe(
      { ...meta, latest_release_at: latestReleaseAt },
      pulls,
      detailSamples,
      commits,
    ),
  );

  const reviewSample = await timedRun("probe review sample", () =>
    sampleReviews(client, repo, detailSamples, opts.ghConcurrent, say),
  );
  const codebaseCalls = await countCodebaseCalls(client, repo, branch);
  const quota = await readQuota(githubClient);
  const cap = analysis.maxPullRequestChangeLines;
  const sampledLines = detailSamples.map(
    (detail) => Number(detail.additions ?? 0) + Number(detail.deletions ?? 0),
  );
  const changeShare =
    cap === undefined || sampledLines.length === 0
      ? 1
      : sampledLines.filter((lines) => lines <= cap).length /
        sampledLines.length;

  const recommendation = ["--include-codebase"];
  if (analysis.includePullRequests)
    recommendation.push("--include-pull-requests");
  if (analysis.includePullRequestChanges) {
    recommendation.push("--include-pull-request-changes");
  }
  if (analysis.includeCommitHistory) {
    recommendation.push("--include-commit-history");
  }
  if (pulls.length || Boolean(meta.has_issues)) {
    recommendation.push("--include-how-repo-works");
  }
  if (analysis.maxPullRequestChangeLines) {
    recommendation.push(
      `--max-pull-request-change-lines=${analysis.maxPullRequestChangeLines}`,
    );
  }
  if (analysis.maxPrMonths) {
    recommendation.push(`--max-pr-months=${analysis.maxPrMonths}`);
  }
  if (analysis.maxCommits) {
    recommendation.push(`--max-commits=${analysis.maxCommits}`);
  }

  const command = ["co-maintainer", "init", repo, ...recommendation].join(" ");
  const report = {
    repo,
    ...analysis.report,
    recommendations: {
      includePullRequests: analysis.includePullRequests,
      includePullRequestChanges: analysis.includePullRequestChanges,
      includeCommitHistory: analysis.includeCommitHistory,
      maxPrMonths: analysis.maxPrMonths ?? "all",
      maxCommits: analysis.maxCommits ?? "all",
      maxPullRequestChangeLines: analysis.maxPullRequestChangeLines ?? "all",
    },
    reasons: analysis.reasons,
    recommendedCommand: command,
    createdAt: new Date().toISOString(),
  };

  return {
    analysis,
    recommendation,
    command,
    report,
    pullUpdatedAt: pulls.map((pull) => String(pull.updated_at ?? "")),
    changeShare,
    reviewSample,
    github: { ...stats(), quota, codebaseCalls },
  };
}

/** How many calls the codebase read of `init` would take, from the tree:
 * the tree itself, the instruction files under the default pattern, and the
 * important files. */
async function countCodebaseCalls(
  client: GitHubClient,
  repo: string,
  branch: string,
): Promise<number | undefined> {
  try {
    const response = await client.request<Json>(
      `repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    const tree = (Array.isArray(response.tree) ? response.tree : [])
      .filter((item) => (item as Json).type === "blob")
      .map((item) => String((item as Json).path));
    const pattern = agentInstructionsPattern(undefined);
    const instructions = pattern ? matchInstructionPaths(tree, pattern) : [];
    const important = importantCodebasePaths(tree, new Set(instructions));
    return 1 + instructions.length + important.length;
  } catch {
    return undefined;
  }
}

/** The newest reviewable pull requests of the sample, with their files: the
 * diff a review would be given. A pull request whose files cannot be read is
 * left out. */
async function sampleReviews(
  client: GitHubClient,
  repo: string,
  details: Json[],
  concurrency: number,
  say: (message: string) => void,
): Promise<ReviewSamplePull[]> {
  const newest = details
    .filter(reviewable)
    .sort((a, b) =>
      String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")),
    )
    .slice(0, REVIEW_SAMPLE_SIZE);
  say(`reading files of ${newest.length} recent pull requests`);
  const sample: (ReviewSamplePull | undefined)[] = Array.from({
    length: newest.length,
  });
  let cursor = 0;
  const worker = async () => {
    while (cursor < newest.length) {
      const index = cursor++;
      const detail = newest[index];
      const number = Number(detail.number);
      try {
        const files = await client.pages<Json>(
          `repos/${repo}/pulls/${number}/files`,
        );
        sample[index] = {
          number,
          changedLines:
            Number(detail.additions ?? 0) + Number(detail.deletions ?? 0),
          files: files.map((file) => ({
            changes: Number(file.changes ?? 0),
            patchChars: String(file.patch ?? "").length,
          })),
        };
      } catch {
        // One unreadable pull request leaves the rest of the sample.
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), newest.length) },
      worker,
    ),
  );
  return sample.filter((pull): pull is ReviewSamplePull => pull !== undefined);
}

/** The `RepoConfig` patch that matches a recommendation, so a confirmed
 * preview stores the same limits the printed command carries. */
export function recommendationPatch(recommendation: string[]): {
  includeCodebase: boolean;
  includePullRequests: boolean;
  includePullRequestChanges: boolean;
  includeCommitHistory: boolean;
  includeHowRepoWorks: boolean;
  maxPrMonths?: number;
  maxCommits?: number;
  maxPullRequestChangeLines?: number;
} {
  const has = (flag: string) => recommendation.includes(flag);
  const value = (name: string): number | undefined => {
    const match = recommendation.find((flag) => flag.startsWith(`${name}=`));
    if (!match) return undefined;
    const number = Number(match.slice(name.length + 1));
    return Number.isFinite(number) ? number : undefined;
  };
  return {
    includeCodebase: has("--include-codebase"),
    includePullRequests: has("--include-pull-requests"),
    includePullRequestChanges: has("--include-pull-request-changes"),
    includeCommitHistory: has("--include-commit-history"),
    includeHowRepoWorks: has("--include-how-repo-works"),
    maxPrMonths: value("--max-pr-months"),
    maxCommits: value("--max-commits"),
    maxPullRequestChangeLines: value("--max-pull-request-change-lines"),
  };
}
