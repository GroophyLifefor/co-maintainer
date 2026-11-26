import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mayStartReview,
  noteRateLimit,
  resetBudgetsForTest,
  REVIEW_COST,
} from "./budget.ts";

const NOW = 1_800_000_000_000;
const RESET = Math.floor(NOW / 1000) + 3600;

function headers(remaining: number, reset = RESET, limit = 5000): Headers {
  return new Headers({
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(reset),
    "x-ratelimit-resource": "core",
  });
}

test("with nothing known, or after the reset, a review may start", () => {
  resetBudgetsForTest();
  assert.equal(mayStartReview(1, 0, NOW), true);
  noteRateLimit(1, headers(0));
  assert.equal(mayStartReview(1, 0, NOW), false);
  assert.equal(mayStartReview(1, 0, (RESET + 1) * 1000), true);
  assert.equal(mayStartReview(undefined, 5, NOW), true);
});

test("a review needs its cost, the cost of the running reviews and a tenth of the hour in reserve", () => {
  resetBudgetsForTest();
  const reserve = 500;
  noteRateLimit(1, headers(reserve + REVIEW_COST));
  assert.equal(mayStartReview(1, 0, NOW), true);
  assert.equal(mayStartReview(1, 1, NOW), false);
  noteRateLimit(1, headers(reserve + 2 * REVIEW_COST - 1, RESET));
  assert.equal(mayStartReview(1, 1, NOW), false);
});

test("an answer that arrives late with a higher count does not undo a later one", () => {
  resetBudgetsForTest();
  noteRateLimit(2, headers(19));
  noteRateLimit(2, headers(20));
  // 20 would have admitted a review with 6 left to spare. 19 does not.
  noteRateLimit(2, headers(0, RESET, 5000));
  noteRateLimit(2, headers(4999, RESET, 5000));
  assert.equal(mayStartReview(2, 0, NOW), false);
});

test("a later reset is a new hour and replaces what was there", () => {
  resetBudgetsForTest();
  noteRateLimit(3, headers(0));
  assert.equal(mayStartReview(3, 0, NOW), false);
  noteRateLimit(3, headers(5000, RESET + 3600));
  assert.equal(mayStartReview(3, 0, NOW), true);
});

test("other limits and answers without the headers are ignored", () => {
  resetBudgetsForTest();
  const search = headers(0);
  search.set("x-ratelimit-resource", "search");
  noteRateLimit(4, search);
  noteRateLimit(4, new Headers());
  assert.equal(mayStartReview(4, 0, NOW), true);
});
