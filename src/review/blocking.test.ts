/** One blocking decision for every review path (CORE-41, F19).
 *
 * F19: the same pull request was reviewed twice, the same P2 finding came back
 * `non-blocking` the first time and `blocking` the second, and the exit code
 * changed because the model's label moved. `severity` mode removes that
 * wobble; `model` keeps the 0.4.13 behavior, so no existing review changes its
 * exit code. Both rules live in one module so local, PR, remote and the GitHub
 * App cannot drift apart.
 */
import { test } from "node:test";
import {
  DEFAULT_REVIEW_BLOCKING,
  impactWord,
  isBlocking,
  reviewBlockingFrom,
} from "./blocking.ts";

function must(value: boolean, what: string): void {
  if (!value) throw new Error(what);
}

test("an unset or unknown mode is the default, model", () => {
  must(reviewBlockingFrom(undefined) === "model", "undefined");
  must(reviewBlockingFrom("nonsense") === "model", "unknown");
  must(reviewBlockingFrom("") === "model", "empty");
  must(DEFAULT_REVIEW_BLOCKING === "model", "the default itself");
  must(reviewBlockingFrom("severity") === "severity", "severity");
});

test("model mode keeps the 0.4.13 rule", () => {
  // The model's own label decides.
  must(
    isBlocking("model", {
      severity: "P2",
      text: "[P2 · non-blocking] `a.ts`",
    }) === false,
    "a non-blocking P2",
  );
  must(
    isBlocking("model", { severity: "P1", text: "[P1 · blocking] `a.ts`" }) ===
      true,
    "a blocking P1",
  );
  // A P0 always blocks, even when the model labeled it otherwise.
  must(
    isBlocking("model", {
      severity: "P0",
      text: "[P0 · non-blocking] `a.ts`",
    }) === true,
    "a P0 the model called non-blocking",
  );
  // A JSON answer's structured `blocking` field counts too.
  must(
    isBlocking("model", { severity: "P2", blocked: true }) === true,
    "the structured blocking field",
  );
  must(
    isBlocking("model", { severity: "P2", blocked: false }) === false,
    "the structured non-blocking field",
  );
});

test("severity mode ignores the model and uses P0/P1 only", () => {
  for (const [severity, expected] of [
    ["P0", true],
    ["P1", true],
    ["P2", false],
    ["P3", false],
  ] as const) {
    must(
      isBlocking("severity", { severity }) === expected,
      `${severity} in severity mode`,
    );
  }
  // The model's own label is irrelevant, which is the point of the mode.
  must(
    isBlocking("severity", {
      severity: "P2",
      blocked: true,
      text: "[P2 · blocking] `a.ts`",
    }) === false,
    "a P2 the model called blocking",
  );
  must(
    isBlocking("severity", {
      severity: "P1",
      blocked: false,
      text: "[P1 · non-blocking] `a.ts`",
    }) === true,
    "a P1 the model called non-blocking",
  );
  // Lowercase severities from a JSON answer still resolve.
  must(isBlocking("severity", { severity: "p0" }) === true, "lowercase p0");
});

test("the decision is stable for the same finding set", () => {
  // F19 in one line: the same two findings, reviewed twice, must yield the
  // same per-finding decision under `severity` even if the model's labels
  // changed between the runs.
  const first = [
    { severity: "P2", blocked: true, text: "[P2 · blocking] `a.ts`" },
    { severity: "P1", blocked: false, text: "[P1 · non-blocking] `b.ts`" },
  ];
  const second = [
    { severity: "P2", blocked: false, text: "[P2 · non-blocking] `a.ts`" },
    { severity: "P1", blocked: true, text: "[P1 · blocking] `b.ts`" },
  ];
  for (let index = 0; index < first.length; index++) {
    const a = isBlocking("severity", first[index]);
    const b = isBlocking("severity", second[index]);
    if (a !== b) {
      throw new Error(`finding ${index}: ${a} then ${b}`);
    }
  }
});

test("impactWord agrees with isBlocking", () => {
  const finding = {
    severity: "P1",
    blocked: false,
    text: "[P1 · non-blocking] x",
  };
  // Under severity mode the heading must read `blocking`, because that is the
  // decision the exit code used; a mismatched label is exactly F19.
  must(impactWord("severity", finding) === "blocking", "severity P1");
  must(impactWord("model", finding) === "non-blocking", "model P1");
});
