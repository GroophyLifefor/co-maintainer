/** The probe's estimate, shared by the CLI and the dashboard's Add
 * repository preview so both show the same numbers.
 *
 * For the recommended `init` it says how many GitHub calls and AI jobs the
 * run makes and how long they take. When that is over 30 minutes it also
 * offers a faster `init` with a shorter PR window and fewer commits, worked
 * out from the same listing. It also estimates what one pull request review
 * costs, from the newest reviewable pull requests. */
import {
  type Estimate,
  estimateGithub,
  estimateInit,
  type GithubEstimate,
  readJobHistory,
} from "../ai/estimate.ts";
import { loadPrices, type ModelPrice } from "../ai/pricing.ts";
import { estimateReview, type ReviewEstimate } from "../ai/review_estimate.ts";
import {
  type ProbePlan,
  pullRequestsInWindow,
  recommendationPatch,
} from "./probe.ts";

/** Over this, the probe offers a faster option. */
export const FASTER_TARGET_SECONDS = 30 * 60;
/** PR windows the faster option tries, longest first. */
const FASTER_MONTHS = [24, 12, 6, 3];
/** The fewest commits a faster option keeps. */
const MIN_COMMITS = 100;

export type Bottleneck = "github" | "ai" | "close";

export type InitOption = {
  maxPrMonths?: number;
  maxCommits?: number;
  recommendation: string[];
  command: string;
  pullRequests: number;
  commits: number;
  ai: Estimate;
  github: GithubEstimate;
  /** GitHub first, then the AI jobs: the whole run. */
  seconds: [number, number];
  bottleneck: Bottleneck;
};

export type ProbeEstimate = {
  recommended: InitOption;
  /** Only when the recommended run is over 30 minutes and a shorter window
   * is faster. */
  faster?: InitOption;
  review?: ReviewEstimate;
  /** True when no price is known because no models were given. */
  modelsMissing: boolean;
  /** True when OpenRouter prices were needed but could not be read. */
  pricesUnavailable: boolean;
};

export type ProbeEstimateOptions = {
  repo: string;
  ai: string;
  lowModel?: string;
  highModel?: string;
  ghConcurrent: number;
  aiConcurrent: number;
  now?: number;
};

export async function estimateProbe(
  plan: ProbePlan,
  options: ProbeEstimateOptions,
): Promise<ProbeEstimate> {
  // Prices are only fetched when an OpenRouter model would be billed, so a
  // plain `--ai=none` probe makes no network call.
  const modelsGiven = Boolean(options.lowModel && options.highModel);
  const needsPrices = options.ai === "openrouter" && modelsGiven;
  const [prices, history] = await Promise.all([
    needsPrices
      ? loadPrices()
      : Promise.resolve({
          prices: new Map<string, ModelPrice>(),
          source: "unavailable" as const,
        }),
    readJobHistory(options.repo),
  ]);
  const low = options.lowModel
    ? prices.prices.get(options.lowModel)
    : undefined;
  const high = options.highModel
    ? prices.prices.get(options.highModel)
    : undefined;

  const option = (maxPrMonths?: number, maxCommits?: number): InitOption =>
    initOption(plan, options, prices.prices, history, maxPrMonths, maxCommits);
  const recommended = option(
    plan.analysis.maxPrMonths,
    plan.analysis.maxCommits,
  );
  return {
    recommended,
    faster: fasterOption(recommended, option),
    review: estimateReview(plan.reviewSample, { low, high }),
    modelsMissing: !modelsGiven,
    pricesUnavailable: needsPrices && prices.source === "unavailable",
  };
}

function initOption(
  plan: ProbePlan,
  options: ProbeEstimateOptions,
  prices: Map<string, ModelPrice>,
  history: Awaited<ReturnType<typeof readJobHistory>>,
  maxPrMonths: number | undefined,
  maxCommits: number | undefined,
): InitOption {
  const recommendation = withWindow(
    plan.recommendation,
    maxPrMonths,
    maxCommits,
  );
  const flags = recommendationPatch(recommendation);
  const pullRequests = flags.includePullRequests
    ? pullRequestsInWindow(plan.pullUpdatedAt, maxPrMonths)
    : 0;
  const totalCommits = Number(plan.analysis.report.commits ?? 0);
  const commits = flags.includeCommitHistory
    ? Math.min(maxCommits ?? totalCommits, totalCommits)
    : 0;
  const ai = estimateInit({
    pullRequests,
    includeCodebase: flags.includeCodebase,
    includeHowRepoWorks: flags.includeHowRepoWorks,
    lowModel: options.lowModel,
    highModel: options.highModel,
    prices,
    history,
    aiConcurrent: options.aiConcurrent,
  });
  const github = estimateGithub({
    includePullRequests: flags.includePullRequests,
    pullRequests,
    includeChanges: flags.includePullRequestChanges,
    changeShare: plan.changeShare,
    includeCodebase: flags.includeCodebase || flags.includeHowRepoWorks,
    codebaseCalls: plan.github.codebaseCalls,
    commits,
    ghConcurrent: options.ghConcurrent,
    secondsPerCall: plan.github.secondsPerCall,
    quota: plan.github.quota,
    now: options.now,
  });
  return {
    maxPrMonths,
    maxCommits,
    recommendation,
    command: ["co-maintainer", "init", plan.report.repo, ...recommendation]
      .map(String)
      .join(" "),
    pullRequests,
    commits,
    ai,
    github,
    seconds: [
      ai.seconds[0] + github.seconds[0],
      ai.seconds[1] + github.seconds[1],
    ],
    bottleneck: bottleneck(ai.seconds, github.seconds),
  };
}

/** Which part decides the time. Within a quarter of each other they are
 * "close". */
function bottleneck(
  ai: [number, number],
  github: [number, number],
): Bottleneck {
  const a = ai[0] + ai[1];
  const g = github[0] + github[1];
  if (a === 0 && g === 0) return "ai";
  if (Math.abs(a - g) <= 0.25 * Math.max(a, g)) return "close";
  return a > g ? "ai" : "github";
}

/** The first shorter window, with half the commits each step, that fits in
 * 30 minutes. When none fits, the shortest one, if it is faster at all. */
function fasterOption(
  recommended: InitOption,
  option: (maxPrMonths?: number, maxCommits?: number) => InitOption,
): InitOption | undefined {
  if (recommended.seconds[1] <= FASTER_TARGET_SECONDS) return undefined;
  const current = recommended.maxPrMonths ?? Infinity;
  const months = FASTER_MONTHS.filter((month) => month < current);
  const flags = recommendationPatch(recommended.recommendation);
  let commits = flags.includeCommitHistory ? recommended.commits : undefined;
  let last: InitOption | undefined;
  for (const month of months) {
    if (commits !== undefined) {
      commits = Math.max(MIN_COMMITS, Math.floor(commits / 2 / 100) * 100);
    }
    last = option(month, commits);
    if (last.seconds[1] <= FASTER_TARGET_SECONDS) return last;
  }
  if (!last || last.seconds[1] >= recommended.seconds[1]) return undefined;
  return last;
}

/** The recommendation with its PR window and commit limit replaced. */
function withWindow(
  recommendation: string[],
  maxPrMonths: number | undefined,
  maxCommits: number | undefined,
): string[] {
  const kept = recommendation.filter(
    (flag) =>
      !flag.startsWith("--max-pr-months=") &&
      !flag.startsWith("--max-commits="),
  );
  if (maxPrMonths !== undefined) kept.push(`--max-pr-months=${maxPrMonths}`);
  if (maxCommits !== undefined) kept.push(`--max-commits=${maxCommits}`);
  return kept;
}
