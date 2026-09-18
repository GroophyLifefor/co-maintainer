import { clampImproveMatrix, clampToolRounds, filePatch } from "./reviewer.ts";
import { test } from "node:test";

function contains(haystack: string, needle: string, what: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${what}: ${JSON.stringify(haystack)} lacks ${needle}`);
  }
}

test("filePatch numbers a present patch", () => {
  const patch = "@@ -1,2 +1,3 @@\n context\n+added";
  const expected = "@@ -1,2 +1,3 @@\n     1  context\n     2 +added";
  if (filePatch({ filename: "a.ts", patch }) !== expected) {
    throw new Error("expected the patch with new file line numbers");
  }
});

test("filePatch says so when GitHub withheld the diff", () => {
  const rendered = filePatch({
    filename: "pnpm-lock.yaml",
    status: "modified",
    changes: 1133,
    additions: 900,
    deletions: 233,
  });
  contains(rendered, "1133 changed lines", "counts");
  contains(rendered, "+900 -233", "split");
  contains(rendered, "withheld by GitHub", "reason");
  contains(rendered, "Do not treat this file as unchanged", "instruction");
});

test("filePatch still reports a withheld file with no counts", () => {
  const rendered = filePatch({ filename: "big.bin", status: "modified" });
  contains(rendered, "unreported number of changed lines", "fallback");
  contains(rendered, "withheld by GitHub", "reason");
});

test("filePatch marks a per-file truncation", () => {
  const rendered = filePatch({
    filename: "huge.ts",
    status: "modified",
    changes: 5000,
    patch: "x".repeat(20_000),
  });
  contains(rendered, "cut off here", "marker");
  contains(rendered, "5000 changed lines total", "counts");
  if (rendered.length > 13_000) throw new Error("expected the patch trimmed");
});

test("clampToolRounds scales with diff size but never runs away", () => {
  if (clampToolRounds(0) !== 4) throw new Error("small diff should stay at 4");
  if (clampToolRounds(200) !== 6) {
    throw new Error("expected 4 + 200/100 = 6");
  }
  if (clampToolRounds(100_000) !== 8) {
    throw new Error("a huge diff must still be capped at 8");
  }
});

test("clampImproveMatrix stays within 1 and 4", () => {
  if (clampImproveMatrix(0) !== 1) throw new Error("must not go below 1");
  if (clampImproveMatrix(2) !== 2) {
    throw new Error("a normal value passes through");
  }
  if (clampImproveMatrix(10) !== 4) {
    throw new Error("must not exceed the provider's token budget");
  }
});
