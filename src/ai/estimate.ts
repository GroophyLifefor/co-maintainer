/** Cost and time estimate for the recommended `init` (CORE-24, F17).
 *
 * Three sources, in order of trust:
 *
 * 1. Job counts come from the same inputs the real run uses — the number of
 *    pull requests, whether the codebase is read, and the ten synthesis
 *    sections — so the shape is exact.
 * 2. Dollars come from the live OpenRouter price for the configured models.
 *    When prices are unavailable the estimate reports tokens but no dollars
 *    rather than guessing one.
 * 3. Time and per-job tokens come from this repository's recorded jobs when
 *    there are enough, and from the calibration below otherwise.
 *
 * Calibration (plan §CORE-24): cm-dx-lab, 4 pull requests and 8 files, 5
 * extract and 9 synth jobs, 151 s, $0.0014 — about 151/14 ≈ 10.8 s per job.
 * Token counts per job are near 2.4k in and 0.7k out. The text always says
 * the numbers are an estimate. */
import { cacheValues } from "../store/cache_db.ts";
import { sectionKeys } from "../knowledge/sections.ts";
import type { ModelPrice } from "./pricing.ts";

/** Measured averages used when no history exists (cm-dx-lab calibration). */
const CALIBRATION = {
  seconds: 10.8,
  tokensIn: 2_400,
  tokensOut: 700,
};

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
  lowModel?: string;
  highModel?: string;
  prices: Map<string, ModelPrice>;
  history?: RecordedJob;
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
    includeHowRepoWorks: true,
  });
  const synth = sectionKeys.length;
  const jobs = extract + synth;
  const per = input.history ?? CALIBRATION;
  const seconds = band(jobs * per.seconds);
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
