/** The reading half of `co-maintainer probe`, shared by the CLI and the
 * dashboard's Add repository preview (CORE-73).
 *
 * It only reads: no guide is written, nothing is cached here. The CLI adds
 * the estimate, the printing and `--run`; `/api/repos/preview` adds the
 * access check and returns the plan for confirmation. Keeping one
 * implementation means the number an operator confirms is the number `init`
 * would be given. */
import { analyzeProbe } from "../knowledge/probe.ts";
import type { ProbeResult } from "../knowledge/probe.ts";
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
};

/** Samples this many pull requests for diff sizes, on top of a few per year. */
const SAMPLE_HEAD = 30;
const SAMPLE_PER_YEAR = 3;

export async function probePlan(
  client: GitHubClient,
  repo: string,
  opts: {
    ghConcurrent: number;
    logTime?: boolean;
    log?: (message: string) => void;
  },
): Promise<ProbePlan> {
  const say = opts.log ?? (() => {});
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

  return { analysis, recommendation, command, report };
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
