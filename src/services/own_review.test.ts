import assert from "node:assert/strict";
import { test } from "node:test";
import { ownReviewOfHead } from "./review.ts";

const HEAD = "a".repeat(40);
const review = (over: Record<string, unknown> = {}) => ({
  commit_id: HEAD,
  user: { type: "Bot", login: "co-maintainer[bot]" },
  body: "Summary\n\n- Activity: job-1\n- co-maintainer version: 0.7.37\n",
  ...over,
});

test("this App's review of the head is found by its Activity line", () => {
  assert.equal(ownReviewOfHead([review()], HEAD), true);
});

test("another bot's review, a person's, and a review of another commit are not this App's", () => {
  assert.equal(
    ownReviewOfHead([review({ body: "Lint passed." })], HEAD),
    false,
    "another bot has no Activity line",
  );
  assert.equal(
    ownReviewOfHead([review({ user: { type: "User", login: "ada" } })], HEAD),
    false,
    "a person who quotes the line is not a bot",
  );
  assert.equal(
    ownReviewOfHead([review({ commit_id: "b".repeat(40) })], HEAD),
    false,
    "an earlier commit",
  );
  assert.equal(ownReviewOfHead([], HEAD), false);
});

test("with this App's login known, another bot that copies the metadata lines is not this App", () => {
  const other = review({
    user: { type: "Bot", login: "other-review-bot[bot]" },
  });
  assert.equal(ownReviewOfHead([other], HEAD, "co-maintainer[bot]"), false);
  assert.equal(ownReviewOfHead([review()], HEAD, "co-maintainer[bot]"), true);
  // Without the login the body alone decides, as it did.
  assert.equal(ownReviewOfHead([other], HEAD), true);
});

test("the Activity line alone is not enough, the version line is needed too", () => {
  assert.equal(
    ownReviewOfHead([review({ body: "Notes\n\n- Activity: job-9\n" })], HEAD),
    false,
  );
});

test("one of several reviews is enough", () => {
  assert.equal(
    ownReviewOfHead(
      [review({ body: "x" }), review({ commit_id: "c".repeat(40) }), review()],
      HEAD,
    ),
    true,
  );
});
