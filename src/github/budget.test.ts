import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countJobRequest,
  mayStartReview,
  noteRateLimit,
  noteReviewCost,
  resetBudgetsForTest,
  reviewCost,
  REVIEW_COST,
  RUNNING_REVIEW_UNFINISHED,
  takeJobRequests,
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

test("a review needs its cost, what the running reviews have still to spend and a tenth of the hour in reserve", () => {
  resetBudgetsForTest();
  const reserve = 500;
  noteRateLimit(1, headers(reserve + REVIEW_COST));
  assert.equal(mayStartReview(1, 0, NOW), true);
  assert.equal(mayStartReview(1, 1, NOW), false);
  // One running review has spent part of its cost already: only the rest is
  // counted, not the whole cost again.
  const needed = reserve + REVIEW_COST + RUNNING_REVIEW_UNFINISHED;
  assert.ok(RUNNING_REVIEW_UNFINISHED < REVIEW_COST);
  noteRateLimit(1, headers(needed - 1, RESET));
  assert.equal(mayStartReview(1, 1, NOW), false);
  noteRateLimit(1, headers(needed - 2, RESET));
  assert.equal(mayStartReview(1, 1, NOW), false);
});

test("exactly enough covers the running review's rest and one more", () => {
  resetBudgetsForTest();
  const needed = 500 + REVIEW_COST + RUNNING_REVIEW_UNFINISHED;
  noteRateLimit(5, headers(needed));
  assert.equal(mayStartReview(5, 1, NOW), true);
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

test("a stale answer from an earlier hour does not replace the newer hour, even with a lower count", () => {
  resetBudgetsForTest();
  noteRateLimit(6, headers(5000, RESET + 3600));
  noteRateLimit(6, headers(10, RESET));
  assert.equal(mayStartReview(6, 0, (RESET + 1) * 1000), true);
  assert.equal(mayStartReview(6, 0, NOW), true);
});

test("the expected review cost is learned per installation from recent reviews", () => {
  resetBudgetsForTest();
  assert.equal(reviewCost(7), REVIEW_COST);
  for (const n of [10, 10, 10, 10]) noteReviewCost(7, n);
  assert.equal(reviewCost(7), REVIEW_COST, "four samples are not enough");
  noteReviewCost(7, 10);
  assert.equal(reviewCost(7), 10);
  for (const n of [10, 10, 10, 10, 10, 10, 10, 10, 30]) noteReviewCost(7, n);
  assert.equal(reviewCost(7), 10, "one large review in ten is under the p90");
  noteReviewCost(7, 30);
  noteReviewCost(7, 30);
  assert.equal(reviewCost(7), 30, "the large ones now set the cost");
  assert.equal(
    reviewCost(8),
    REVIEW_COST,
    "another installation is unaffected",
  );
});

test("a learned cost stays between the smallest review and a ceiling", () => {
  resetBudgetsForTest();
  for (let i = 0; i < 6; i++) noteReviewCost(1, 2);
  assert.equal(reviewCost(1), 9);
  for (let i = 0; i < 20; i++) noteReviewCost(1, 500);
  assert.equal(reviewCost(1), 60);
});

test("job request counts are taken once and forgotten", () => {
  resetBudgetsForTest();
  countJobRequest("j1");
  countJobRequest("j1");
  countJobRequest(undefined);
  assert.equal(takeJobRequests("j1"), 2);
  assert.equal(takeJobRequests("j1"), 0);
});
