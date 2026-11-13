import { test } from "node:test";
import {
  checkLabel,
  formatSummary,
  resultSlug,
  spread,
  summarizeRuns,
  summarySlug,
} from "./repeat.ts";

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

function near(actual: number, expected: number, what: string): void {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${what}: got ${actual}, want ${expected}`);
  }
}

test("checkLabel accepts plain names and refuses anything that is a path", () => {
  for (const ok of ["checks", "checks-v2", "a.b_c", "3rd"]) {
    same(checkLabel(ok), ok, ok);
  }
  for (const bad of ["", "../x", "a/b", "a\\b", ".hidden", "-x", "a b", ".."]) {
    let threw = false;
    try {
      checkLabel(bad);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`${JSON.stringify(bad)} was accepted`);
  }
});

test("resultSlug keeps the baseline name and adds label and run number", () => {
  const base = "o-r-comaintainer";
  same(resultSlug(base, undefined, 1, 1), base, "baseline");
  same(resultSlug(base, "checks", 1, 1), `${base}-checks`, "label");
  same(resultSlug(base, undefined, 2, 3), `${base}-run2`, "run number");
  same(resultSlug(base, "checks", 3, 3), `${base}-checks-run3`, "both");
  same(summarySlug(base, "checks"), `${base}-checks-runs`, "summary");
  same(summarySlug(base, undefined), `${base}-runs`, "summary, no label");
});

test("spread gives mean, sample standard deviation, min and max", () => {
  const s = spread([2, 4, 4, 4, 5, 5, 7, 9]);
  near(s.mean, 5, "mean");
  // Sum of squares is 32, over n - 1 = 7.
  near(s.stddev, Math.sqrt(32 / 7), "stddev");
  near(s.min, 2, "min");
  near(s.max, 9, "max");
  same(spread([3]), { mean: 3, stddev: 0, min: 3, max: 3 }, "one value");
  same(spread([]), { mean: 0, stddev: 0, min: 0, max: 0 }, "no values");
});

test("summarizeRuns reads each metric across runs", () => {
  const summary = summarizeRuns([
    { precision: 0.4, controlFalsePositiveTotal: 10, totalCost: 0.1 },
    { precision: 0.6, controlFalsePositiveTotal: 14, totalCost: 0.3 },
    { precision: 0.5, controlFalsePositiveTotal: 12 },
  ]);
  near(summary.precision.mean, 0.5, "precision mean");
  near(summary.precision.stddev, 0.1, "precision stddev");
  near(summary.controlFalsePositiveTotal.mean, 12, "fp mean");
  near(summary.controlFalsePositiveTotal.min, 10, "fp min");
  near(summary.controlFalsePositiveTotal.max, 14, "fp max");
  // A missing field counts as 0, so it widens the spread.
  near(summary.totalCost.min, 0, "missing cost counts as 0");
});

test("formatSummary names every metric once", () => {
  const text = formatSummary(
    summarizeRuns([{ recall: 1 }, { recall: 0.5 }]),
    2,
  );
  if (!text.includes("MEAN AND SPREAD over 2 runs")) throw new Error(text);
  same(
    text.split("\n").filter((l) => l.includes("recall")).length,
    1,
    "recall",
  );
  if (!text.includes("controlNiceToHaveTotal")) throw new Error(text);
});
