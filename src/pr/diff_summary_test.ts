import {
  DIFF_SUMMARY_THRESHOLD,
  needsSummary,
  readFullDiff,
} from "./diff_summary.ts";

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

Deno.test("needsSummary triggers only over the threshold with a real patch", () => {
  same(needsSummary(DIFF_SUMMARY_THRESHOLD, "diff"), false, "at threshold");
  same(
    needsSummary(DIFF_SUMMARY_THRESHOLD + 1, "diff"),
    true,
    "over threshold",
  );
  same(needsSummary(10_000, ""), false, "no patch to summarize");
});

Deno.test("readFullDiff returns the stored patch for its path, numbered", () => {
  const patchByPath = new Map([["a.ts", "@@ -1 +7 @@\n+real"]]);
  same(
    readFullDiff(patchByPath, { path: "a.ts" }),
    "@@ -1 +7 @@\n     7 +real",
    "hit",
  );
});

Deno.test("readFullDiff explains an empty summary set plainly", () => {
  const message = readFullDiff(new Map(), { path: "a.ts" });
  if (!message.includes("every file's diff is already shown")) {
    throw new Error(`unexpected message: ${message}`);
  }
});

Deno.test("readFullDiff lists what is available when the path does not match", () => {
  const patchByPath = new Map([["a.ts", "patch-a"], ["b.ts", "patch-b"]]);
  const message = readFullDiff(patchByPath, { path: "c.ts" });
  if (!message.includes("a.ts") || !message.includes("b.ts")) {
    throw new Error(`unexpected message: ${message}`);
  }
});
