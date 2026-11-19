/** The review cost estimate follows the review's own rules: tool rounds grow
 * with the diff, a big file is summarized by the low model, and the diff
 * stops at the review's cap. */
import { test } from "node:test";
import {
  estimateReview,
  REVIEW_PROMPT_TOKENS,
  reviewCost,
  type ReviewSamplePull,
} from "./review_estimate.ts";
import type { ModelPrice } from "./pricing.ts";

const HIGH: ModelPrice = { usdPerMillionIn: 1, usdPerMillionOut: 10 };
const LOW: ModelPrice = { usdPerMillionIn: 0.1, usdPerMillionOut: 0.4 };

const pull = (
  number: number,
  changedLines: number,
  files: ReviewSamplePull["files"],
): ReviewSamplePull => ({ number, changedLines, files });

test("review estimate: a small pull request is two calls of prompt plus diff", () => {
  const cost = reviewCost(pull(1, 0, [{ changes: 0, patchChars: 400 }]), {
    high: HIGH,
    low: LOW,
  });
  // One tool round and the answer: the prompt and diff twice, plus the one
  // round of tool results the answer carries.
  if (cost.rounds !== 2) throw new Error(`rounds: ${cost.rounds}`);
  if (cost.tokensIn !== 2 * (REVIEW_PROMPT_TOKENS + 100) + 500) {
    throw new Error(`tokens in: ${cost.tokensIn}`);
  }
  if (cost.usd === undefined) throw new Error("a priced model gives dollars");
});

test("review estimate: a big pull request uses every allowed round and the answer", () => {
  const small = reviewCost(pull(1, 40, [{ changes: 40, patchChars: 2_000 }]), {
    high: HIGH,
  });
  const big = reviewCost(pull(2, 900, [{ changes: 400, patchChars: 20_000 }]), {
    high: HIGH,
  });
  if (big.rounds !== 9) throw new Error(`big rounds: ${big.rounds}`);
  if (!(big.tokensIn > small.tokensIn * 5)) {
    throw new Error(`big ${big.tokensIn} vs small ${small.tokensIn}`);
  }
});

test("review estimate: a file over 500 lines with a long patch is summarized", () => {
  const cost = reviewCost(
    pull(3, 1_200, [
      { changes: 1_200, patchChars: 60_000 },
      { changes: 10, patchChars: 500 },
    ]),
    { high: HIGH, low: LOW },
  );
  if (cost.summarized !== 1) throw new Error(`summarized: ${cost.summarized}`);
  // Without the low model's price the summary cannot be priced.
  const unpriced = reviewCost(
    pull(3, 1_200, [{ changes: 1_200, patchChars: 60_000 }]),
    { high: HIGH },
  );
  if (unpriced.usd !== undefined)
    throw new Error("summary needs the low price");
});

test("review estimate: the diff stops at the review's cap", () => {
  const files = Array.from({ length: 60 }, () => ({
    changes: 300,
    patchChars: 12_000,
  }));
  const capped = reviewCost(pull(4, 18_000, files), { high: HIGH });
  const twice = reviewCost(pull(4, 18_000, [...files, ...files]), {
    high: HIGH,
  });
  if (capped.tokensIn !== twice.tokensIn) {
    throw new Error(`${capped.tokensIn} vs ${twice.tokensIn}`);
  }
});

test("review estimate: fewer than five pull requests give no estimate", () => {
  const four = [1, 2, 3, 4].map((n) =>
    pull(n, 10, [{ changes: 10, patchChars: 300 }]),
  );
  if (estimateReview(four, { high: HIGH }) !== undefined) {
    throw new Error("four is too few");
  }
  // Each file has at most 100 changed lines and 4,000 characters, so the diff grows
  // with the line count and nothing is cut or summarized.
  const sample = [10, 20, 30, 400, 900].map((lines, n) =>
    pull(
      n,
      lines,
      Array.from({ length: Math.ceil(lines / 100) }, () => ({
        changes: Math.min(lines, 100),
        patchChars: Math.min(lines, 100) * 40,
      })),
    ),
  );
  const estimate = estimateReview(sample, { high: HIGH });
  if (!estimate) throw new Error("five is enough");
  if (estimate.median.changedLines !== 30) {
    throw new Error(`median: ${estimate.median.changedLines}`);
  }
  if (estimate.highest.changedLines !== 900) {
    throw new Error(`highest: ${estimate.highest.changedLines}`);
  }
});
