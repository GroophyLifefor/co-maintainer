/** Cost and time estimate for the recommended `init`.
 *
 * Three sources, in order of trust:
 *
 * 1. Job counts come from the same inputs the real run uses, the number of
 *    pull requests, whether the codebase is read, and the ten synthesis
 *    sections, so the shape is exact.
 * 2. Dollars come from the live OpenRouter price for the configured models.
 *    When prices are unavailable the estimate reports tokens but no dollars
 *    rather than guessing one.
 * 3. Time and per-job tokens come from this repository's recorded jobs when
 *    there are enough, and from the calibration below otherwise.
 *
 * Calibration: an uncached cm-dx-lab init on 2026-11-19 with gpt-6-luna and
 * gpt-6.1-sol at `--ai-concurrent=3`: 14 extract jobs of 1 to 5 s each, 8
 * synth jobs of 2 to 9 s, then the two guide jobs one after the other, 37 s
 * and 16 s. 24 calls, 28,250 tokens in and 6,684 out, $0.0664. The text
 * always says the numbers are an estimate.
 *
 * `init` reads GitHub first and runs the AI jobs after, so the whole run is
 * the GitHub time plus the AI time. AI jobs run `aiConcurrent` at a time,
 * GitHub calls `ghConcurrent` at a time, and GitHub calls past the hourly
 * quota wait for the next reset. */
import { cacheValues } from "../store/cache_db.ts";
import { sectionKeys } from "../knowledge/sections.ts";
import { BUILTIN_CONCURRENCY } from "../services/concurrency.ts";
import type { ModelPrice } from "./pricing.ts";
import { LISTING_PAGE } from "../github/pr_listing.ts";
import { FILE_BATCH } from "../github/graphql_files.ts";

/** Measured averages used when no history exists (cm-dx-lab calibration).
 * `seconds` is one job's own duration, before concurrency. */
const CALIBRATION = {
  seconds: 5,
  tokensIn: 1_200,
  tokensOut: 300,
};

/** Two of the synth jobs are the guides. They run after the sections, one
 * after the other, so they add their own time whatever the concurrency,
 * and the rest of the jobs share it. */
const GUIDE_JOBS = 2;
const GUIDE_SECONDS = 55;

/** A spread around the point estimate, since a real run varies. */
const SPREAD = 0.25;

const MAX_HISTORY_ROWS = 200;

type RecordedJob = { tokensIn: number; tokensOut: number; seconds: number };

/** Averages this repository's recorded AI jobs from cache.db. `recordAiCost`
 * keys each job `${repo}:${uuid}`, so the history belongs to the repo the
 * estimate is for. Fewer than four jobs is not a trend, so it is ignored. */
export async function readJobHistory(
  repo: string,
): Promise<RecordedJob | undefined> {
  let rows: string[];
  try {
    rows = await cacheValues("cost", `${repo}:`);
  } catch {
    return undefined;
  }
  if (rows.length < 4) return undefined;
  let tokensIn = 0;
  let tokensOut = 0;
  let seconds = 0;
  let counted = 0;
  for (const raw of rows.slice(0, MAX_HISTORY_ROWS)) {
    try {
      const row = JSON.parse(raw) as {
        tokensIn?: number;
        tokensOut?: number;
        seconds?: number;
      };
      tokensIn += Number(row.tokensIn ?? 0);
      tokensOut += Number(row.tokensOut ?? 0);
      seconds += Number(row.seconds ?? CALIBRATION.seconds);
      counted++;
    } catch {
      // A malformed row is skipped, not counted as a zero.
    }
  }
  if (counted === 0) return undefined;
  return {
    tokensIn: tokensIn / counted,
    tokensOut: tokensOut / counted,
    seconds: seconds / counted,
  };
}

export type EstimateInput = {
  /** How many pull requests the recommended flags would read. */
  pullRequests: number;
  /** Whether the recommended flags read the codebase. */
  includeCodebase: boolean;
  /** Whether they read the how-repo-works documents. Unset counts as yes. */
  includeHowRepoWorks?: boolean;
  lowModel?: string;
  highModel?: string;
  prices: Map<string, ModelPrice>;
  history?: RecordedJob;
  /** How many AI jobs run at once. Unset is the built-in default. */
  aiConcurrent?: number;
};

export type Estimate = {
  extract: number;
  synth: number;
  seconds: [number, number];
  tokensIn: [number, number];
  tokensOut: [number, number];
  /** Absent when no price is known for the models. */
  usd?: [number, number];
  basis: "history" | "calibration";
};

/** A low/high band around a point estimate. */
function band(value: number): [number, number] {
  return [value * (1 - SPREAD), value * (1 + SPREAD)];
}

/** The probe's cost line: a dollar range when one is known, otherwise why
 * not, so a provider with no price list (OpenAI, Anthropic) gets its own
 * reason instead of being told to switch to OpenRouter. */
export function estimateCostLine(
  estimate: Estimate,
  ai: string,
  openRouterPricesUnavailable: boolean,
  modelsGiven = false,
): string {
  if (estimate.usd) {
    return `$${estimate.usd[0].toFixed(4)}-$${estimate.usd[1].toFixed(4)}`;
  }
  return costReason(ai, openRouterPricesUnavailable, modelsGiven);
}

/** Said in place of a cost when no models were given. */
export const MODELS_NEEDED =
  "to see the cost estimate, add --ai=openrouter --low-model=<id> --high-model=<id>";

/** Why there is no dollar figure. */
export function costReason(
  ai: string,
  openRouterPricesUnavailable: boolean,
  modelsGiven: boolean,
): string {
  if (ai === "openai-compatible") return "price unknown for this server";
  if (ai !== "none" && ai !== "openrouter") {
    return "estimate unavailable for this provider";
  }
  if (openRouterPricesUnavailable) {
    return "unknown (could not read OpenRouter prices)";
  }
  if (modelsGiven && ai === "openrouter") {
    return "no OpenRouter price for these models";
  }
  return MODELS_NEEDED;
}

/** The number of `extract_unit` jobs the recommended init would queue: one per
 * pull request plus one for the codebase/documents, matching
 * `extractAiFacts`. */
export function extractJobCount(input: {
  pullRequests: number;
  includeCodebase: boolean;
  includeHowRepoWorks: boolean;
}): number {
  let count = input.pullRequests;
  if (input.includeCodebase || input.includeHowRepoWorks) count += 1;
  return count;
}

export function estimateInit(input: EstimateInput): Estimate {
  const extract = extractJobCount({
    pullRequests: input.pullRequests,
    includeCodebase: input.includeCodebase,
    includeHowRepoWorks: input.includeHowRepoWorks ?? true,
  });
  const synth = sectionKeys.length;
  const jobs = extract + synth;
  const per = input.history ?? CALIBRATION;
  const concurrent = Math.max(1, input.aiConcurrent ?? BUILTIN_CONCURRENCY.ai);
  const parallel = Math.max(0, jobs - GUIDE_JOBS);
  const seconds = band((parallel * per.seconds) / concurrent + GUIDE_SECONDS);
  const tokensIn = band(jobs * per.tokensIn);
  const tokensOut = band(jobs * per.tokensOut);

  // Price the extract jobs with the low model and the synth jobs with the
  // high model, which is how `init` splits the work. A model with no known
  // price makes the dollar range unavailable rather than zero.
  const low = input.lowModel ? input.prices.get(input.lowModel) : undefined;
  const high = input.highModel ? input.prices.get(input.highModel) : undefined;
  let usd: [number, number] | undefined;
  if (low && high) {
    const costPerJob =
      (per.tokensIn / 1_000_000) * low.usdPerMillionIn +
      (per.tokensOut / 1_000_000) * low.usdPerMillionOut;
    const costPerSynth =
      (per.tokensIn / 1_000_000) * high.usdPerMillionIn +
      (per.tokensOut / 1_000_000) * high.usdPerMillionOut;
    usd = band(extract * costPerJob + synth * costPerSynth);
  }

  return {
    extract,
    synth,
    seconds,
    tokensIn,
    tokensOut,
    usd,
    basis: input.history ? "history" : "calibration",
  };
}

/** What a GitHub token may still spend this hour, from `/rate_limit`. */
export type GithubQuota = {
  limit: number;
  remaining: number;
  /** When the quota refills, in epoch milliseconds. */
  resetAt: number;
};

export type GithubEstimateInput = {
  /** Whether `init` reads pull requests at all. Unset follows
   * `pullRequests`. */
  includePullRequests?: boolean;
  /** Pull requests `init` would read, already cut to the PR window. */
  pullRequests: number;
  /** Whether `init` downloads each PR's changed files. */
  includeChanges: boolean;
  /** The share of PRs whose diff fits the change line cap, 0 to 1. Only
   * those get the files call. */
  changeShare: number;
  /** Whether `init` reads the codebase or the how-repo-works documents. */
  includeCodebase: boolean;
  /** The calls that read takes, counted from the tree. Unset is the most it
   * can take. */
  codebaseCalls?: number;
  /** The part of `codebaseCalls` that is GraphQL batches. The rest, the
   * tree and the instruction files, is REST. Unset is every call after the
   * tree. */
  codebaseGraphqlCalls?: number;
  /** Commits `init` would read, already cut to `--max-commits`. 0 when the
   * commit history is not read. */
  commits: number;
  ghConcurrent: number;
  /** One GitHub call's own duration, measured by the probe's calls. */
  secondsPerCall: number;
  quota?: GithubQuota;
  now?: number;
};

export type GithubEstimate = {
  calls: number;
  seconds: [number, number];
  /** The calls' own time, before any wait for the quota. */
  callSeconds: number;
  /** Extra seconds waiting for the quota to refill. 0 when the calls fit, or
   * when they take long enough that the quota refills while they run. */
  quotaWaitSeconds: number;
  quota?: GithubQuota;
};

/** The codebase read: the tree, then at most 80 important files in GraphQL
 * batches (`collect.ts`). */
export const CODEBASE_CALLS = 1 + Math.ceil(80 / FILE_BATCH);
const PAGE = 100;
const HOUR_SECONDS = 3_600;

/** The GitHub calls `init` would make, and how long they take. Past the
 * remaining quota, the calls cannot finish before the reset plus one hourly
 * quota per further hour. A slow run reaches those resets anyway, so only
 * the part of that time beyond the calls' own time is waiting. GraphQL
 * calls have their own quota, so only the REST calls count toward it. */
export function estimateGithub(input: GithubEstimateInput): GithubEstimate {
  let rest = 1; // repository metadata
  let graphqlCalls = 0;
  if (input.includeCodebase) {
    const codebase = input.codebaseCalls ?? CODEBASE_CALLS;
    const batches = Math.min(
      codebase,
      input.codebaseGraphqlCalls ?? Math.max(0, codebase - 1),
    );
    rest += codebase - batches; // the tree and the instruction files
    graphqlCalls += batches;
  }
  if (input.includePullRequests ?? input.pullRequests > 0) {
    // One count, then GraphQL pages that bring each pull request's line
    // counts and discussion. An empty window still takes one page.
    graphqlCalls +=
      1 + Math.max(1, Math.ceil(input.pullRequests / LISTING_PAGE));
    const files = input.includeChanges
      ? Math.min(1, Math.max(0, input.changeShare))
      : 0;
    rest += Math.round(input.pullRequests * files);
  }
  if (input.commits > 0) rest += Math.ceil(input.commits / PAGE);
  const calls = rest + graphqlCalls;

  const callSeconds =
    (calls * Math.max(0, input.secondsPerCall)) /
    Math.max(1, input.ghConcurrent);
  const earliest = quotaEarliest(rest, input.quota, input.now ?? Date.now());
  const quotaWaitSeconds = Math.max(0, earliest - callSeconds);
  return {
    calls,
    seconds: band(callSeconds + quotaWaitSeconds),
    callSeconds,
    quotaWaitSeconds,
    quota: input.quota,
  };
}

/** The soonest the calls can finish under the quota, as if each were
 * instant. 0 when they fit in what is left this hour. */
function quotaEarliest(
  calls: number,
  quota: GithubQuota | undefined,
  now: number,
): number {
  if (!quota || quota.limit <= 0 || calls <= quota.remaining) return 0;
  const untilReset = Math.max(0, (quota.resetAt - now) / 1_000);
  const beyond = calls - Math.max(0, quota.remaining);
  return untilReset + (Math.ceil(beyond / quota.limit) - 1) * HOUR_SECONDS;
}
