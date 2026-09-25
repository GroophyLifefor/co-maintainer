/** `review-blocking` reaches every review path (CORE-41).
 *
 * The unit rule lives in `src/review/blocking.test.ts`. These check the four
 * consumers actually honor it:
 *  - the local review exit code and its human output (the F19 surface),
 *  - the PR review exit code,
 *  - the App review's GitHub event,
 *  - the config plumbing that carries the mode into `Options`.
 */
import { test } from "node:test";
import {
  formatHumanLocalReview,
  isBlockingFinding,
  reviewExitCodeFromResolved,
  toJsonFinding,
} from "../cli/review_result.ts";
import { reviewExitCode } from "../cli/review_output.ts";
import { appReviewEvent, reviewEvent } from "../services/review.ts";
import { reviewBlockingFrom } from "../review/blocking.ts";
import type { ResolvedFinding } from "../review/carry_over.ts";
import type { Revision } from "../review/revision.ts";

function must(value: boolean, what: string): void {
  if (!value) throw new Error(what);
}

function row(
  partial: Partial<ResolvedFinding> & Pick<ResolvedFinding, "state" | "title">,
): ResolvedFinding {
  return {
    id: "id",
    path: "a.ts",
    lineFrom: 1,
    lineTo: 1,
    bodyMd: "",
    anchorText: null,
    severity: "P2",
    carriedFromId: null,
    firstSeenReviewId: null,
    ...partial,
  };
}

const REVISION: Revision = {
  files: [
    {
      path: "a.ts",
      previousPath: null,
      status: "modified",
      binary: false,
      additions: 1,
      deletions: 0,
      patch: "",
    },
  ],
  title: "",
  description: "",
  baseLabel: "origin/main",
  producer: "local",
};

/** A P2 the model called blocking: exit 1 under `model`, 0 under `severity`. */
const MODEL_BLOCKING_P2 = row({
  state: "new",
  severity: "P2",
  title: "[P2 · blocking] `a.ts` — `x`",
});

/** A P1 the model called non-blocking: exit 0 under `model`, 1 under
 * `severity`. This is the pair F19 wobbled between. */
const MODEL_CLEAN_P1 = row({
  state: "new",
  severity: "P1",
  title: "[P1 · non-blocking] `a.ts` — `x`",
});

test("local exit code follows the mode", () => {
  must(
    reviewExitCodeFromResolved([MODEL_BLOCKING_P2], "model") === 1,
    "model: a blocking P2 exits 1",
  );
  must(
    reviewExitCodeFromResolved([MODEL_BLOCKING_P2], "severity") === 0,
    "severity: a P2 never exits 1",
  );
  must(
    reviewExitCodeFromResolved([MODEL_CLEAN_P1], "model") === 0,
    "model: a non-blocking P1 exits 0",
  );
  must(
    reviewExitCodeFromResolved([MODEL_CLEAN_P1], "severity") === 1,
    "severity: a P1 always exits 1",
  );
});

test("the PR markdown exit code follows the mode", () => {
  // The same finding, as the model renders it in a heading.
  const markdown = `## Findings

### [P1 · non-blocking] \`a.ts\` — \`x\`
Location: \`a.ts:1\`

Body
`;
  must(reviewExitCode(markdown, "model") === 0, "model");
  must(reviewExitCode(markdown, "severity") === 1, "severity");
});

test("the App review event follows the mode", () => {
  const stored = [{ severity: "P2", title: "[P2 · blocking] `a.ts`" }];
  // `model` keeps 0.4.13: any finding requests changes.
  must(
    appReviewEvent(stored, "model") === "REQUEST_CHANGES",
    "model requests changes",
  );
  must(
    appReviewEvent(stored, "severity") === "COMMENT",
    "severity does not request changes for a P2",
  );
  const high = [{ severity: "P1", title: "[P1 · non-blocking] `a.ts`" }];
  must(
    appReviewEvent(high, "severity") === "REQUEST_CHANGES",
    "severity requests changes for a P1",
  );
  must(
    appReviewEvent([], "severity") === "COMMENT",
    "an empty review never requests changes",
  );
  // A clean review still comments, exactly as before.
  must(reviewEvent(0) === "COMMENT", "the old event rule is unchanged");
  must(reviewEvent(1) === "REQUEST_CHANGES", "the old event rule is unchanged");
});

test("the human output labels the finding the way the exit code decided", () => {
  // Under `severity` the same P2 reads non-blocking, matching exit 0; before
  // F19 the heading and the exit code could disagree.
  const severityText = formatHumanLocalReview(
    "header",
    REVISION,
    null,
    "disabled",
    [MODEL_BLOCKING_P2],
    [],
    "severity",
  );
  must(
    severityText.includes("[P2 · non-blocking]"),
    `severity label:\n${severityText}`,
  );
  must(
    severityText.includes("0 blocking"),
    `severity summary:\n${severityText}`,
  );
  const modelText = formatHumanLocalReview(
    "header",
    REVISION,
    null,
    "disabled",
    [MODEL_BLOCKING_P2],
    [],
    "model",
  );
  must(modelText.includes("[P2 · blocking]"), `model label:\n${modelText}`);
});

test("the JSON output carries the same decision as the exit code", () => {
  const severity = JSON.parse(
    JSON.stringify(toJsonFinding(MODEL_BLOCKING_P2, "severity")),
  ) as { blocking: boolean };
  must(severity.blocking === false, "severity JSON blocking");

  const model = JSON.parse(
    JSON.stringify(toJsonFinding(MODEL_BLOCKING_P2, "model")),
  ) as { blocking: boolean };
  must(model.blocking === true, "model JSON blocking");
});

test("isBlockingFinding keeps its old signature for existing callers", () => {
  // The default argument is the model rule, so a caller that passes only the
  // two old arguments behaves exactly as 0.4.13 did.
  must(
    isBlockingFinding("[P1 · blocking] `a.ts`", "P1") === true,
    "blocking P1",
  );
  must(
    isBlockingFinding("[P2 · non-blocking] `a.ts`", "P2") === false,
    "non-blocking P2",
  );
  must(
    isBlockingFinding("[P0 · non-blocking] `a.ts`", "P0") === true,
    "a P0 always blocks",
  );
});

test("the mode is read from the config the same way everywhere", () => {
  must(reviewBlockingFrom("severity") === "severity", "severity");
  must(reviewBlockingFrom(undefined) === "model", "unset is the default");
  must(reviewBlockingFrom("SECURITY") === "model", "a typo is the default");
});
