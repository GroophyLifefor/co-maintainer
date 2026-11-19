/** What one pull request review would cost, estimated from a few recent pull
 * requests before `init`.
 *
 * A review is not one model call. It runs up to `clampToolRounds` tool
 * rounds, and every round sends the prompt again: the instructions and
 * guide, the diff, and the tool results so far. The diff is built the way
 * the review builds it: a file over 500 changed lines with a long patch is
 * summarized by the low model, a long patch is cut at 12,000 characters, and
 * the whole diff stops at 240,000.
 *
 * The estimate assumes one pass (no `--improve-matrix`) and no codegraph.
 * The constants below are a calibration, so the text always says
 * "estimate": three uncached cm-dx-lab reviews on 2026-11-19 with
 * gpt-6.1-sol and `--disable-codegraph` took 2 to 4 model calls, 4,500 to
 * 6,300 tokens in per call, 586 to 2,148 tokens out, and 341 to 4,149
 * characters of tool results. A repository with longer guides sends more
 * per call. */
import {
  MAX_FILE_PATCH_CHARS,
  MAX_REVIEW_DIFF_CHARS,
  MAX_SUMMARIES,
  PLANNED_SUMMARY_CHARS,
  SUMMARY_MIN_PATCH_CHARS,
} from "../pr/diff_plan.ts";
import { DIFF_SUMMARY_THRESHOLD } from "../pr/diff_summary.ts";
import { clampToolRounds } from "../pr/tool_rounds.ts";
import { DEFAULT_TOOL_BUDGET_CHARS } from "./tool_gate.ts";
import type { ModelPrice } from "./pricing.ts";

/** Instructions plus the review guide, in tokens, sent every round. */
export const REVIEW_PROMPT_TOKENS = 5_000;
/** Answer tokens per round. */
export const REVIEW_OUTPUT_TOKENS_PER_ROUND = 600;
/** A diff this size (changed lines) or larger uses every allowed round. A
 * small one is usually answered in the first. */
export const REVIEW_ALL_ROUNDS_AT_LINES = 400;
/** Tool result characters each round adds to the conversation. */
const TOOL_CHARS_PER_ROUND = 2_000;
/** A review almost always asks one tool before it answers: two calls. */
const MIN_ROUNDS = 2;
/** One summary call: the patch in, a short description out. */
const SUMMARY_OUTPUT_TOKENS = 200;
const CHARS_PER_TOKEN = 4;

/** The fewest sampled pull requests worth an estimate. */
export const REVIEW_SAMPLE_MIN = 5;
/** How many recent pull requests the estimate reads. */
export const REVIEW_SAMPLE_SIZE = 10;

export type ReviewSampleFile = { changes: number; patchChars: number };
export type ReviewSamplePull = {
  number: number;
  changedLines: number;
  files: ReviewSampleFile[];
};

export type ReviewCost = {
  number: number;
  changedLines: number;
  /** Model calls: the tool rounds plus the answer. */
  rounds: number;
  summarized: number;
  tokensIn: number;
  tokensOut: number;
  /** Absent when no price is known for the models. */
  usd?: number;
};

export type ReviewEstimate = {
  sampled: number;
  median: ReviewCost;
  highest: ReviewCost;
};

/** The cost of reviewing one pull request. */
export function reviewCost(
  pull: ReviewSamplePull,
  prices: { low?: ModelPrice; high?: ModelPrice },
): ReviewCost {
  const files = [...pull.files].sort((a, b) => b.patchChars - a.patchChars);
  let summaries = 0;
  let summaryIn = 0;
  let diffChars = 0;
  for (const file of files) {
    const summarize =
      summaries < MAX_SUMMARIES &&
      file.changes > DIFF_SUMMARY_THRESHOLD &&
      file.patchChars > SUMMARY_MIN_PATCH_CHARS;
    if (summarize) {
      summaries++;
      summaryIn += file.patchChars / CHARS_PER_TOKEN;
      diffChars += PLANNED_SUMMARY_CHARS;
    } else {
      diffChars += Math.min(file.patchChars, MAX_FILE_PATCH_CHARS);
    }
  }
  diffChars = Math.min(diffChars, MAX_REVIEW_DIFF_CHARS);

  // Model calls: the tool rounds plus the answer.
  const allowed = clampToolRounds(pull.changedLines) + 1;
  const share = Math.min(1, pull.changedLines / REVIEW_ALL_ROUNDS_AT_LINES);
  const rounds = MIN_ROUNDS + (allowed - MIN_ROUNDS) * share;
  const perRound = REVIEW_PROMPT_TOKENS + diffChars / CHARS_PER_TOKEN;
  // Tool results pile up round by round, never past the tool budget, and
  // every later round sends them again.
  const toolChars = Math.min(
    DEFAULT_TOOL_BUDGET_CHARS,
    ((rounds * (rounds - 1)) / 2) * TOOL_CHARS_PER_ROUND,
  );
  const toolTokens = toolChars / CHARS_PER_TOKEN;
  const reviewIn = rounds * perRound + toolTokens;
  const reviewOut = rounds * REVIEW_OUTPUT_TOKENS_PER_ROUND;
  const summaryOut = summaries * SUMMARY_OUTPUT_TOKENS;

  let usd: number | undefined;
  if (prices.high && (summaries === 0 || prices.low)) {
    usd = cost(reviewIn, reviewOut, prices.high);
    if (summaries > 0 && prices.low) {
      usd += cost(summaryIn, summaryOut, prices.low);
    }
  }
  return {
    number: pull.number,
    changedLines: pull.changedLines,
    rounds: Math.round(rounds),
    summarized: summaries,
    tokensIn: Math.round(reviewIn + summaryIn),
    tokensOut: Math.round(reviewOut + summaryOut),
    usd,
  };
}

function cost(tokensIn: number, tokensOut: number, price: ModelPrice): number {
  return (
    (tokensIn / 1_000_000) * price.usdPerMillionIn +
    (tokensOut / 1_000_000) * price.usdPerMillionOut
  );
}

/** The median and the highest review cost over the sample, or nothing when
 * the sample is too small to say. */
export function estimateReview(
  sample: ReviewSamplePull[],
  prices: { low?: ModelPrice; high?: ModelPrice },
): ReviewEstimate | undefined {
  if (sample.length < REVIEW_SAMPLE_MIN) return undefined;
  const costs = sample
    .map((pull) => reviewCost(pull, prices))
    .sort((a, b) => a.tokensIn - b.tokensIn);
  return {
    sampled: costs.length,
    median: costs[Math.floor((costs.length - 1) / 2)],
    highest: costs[costs.length - 1],
  };
}
