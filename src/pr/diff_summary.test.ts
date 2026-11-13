import {
  DEFAULT_READ_DIFF_MAX_CHARS,
  DIFF_SUMMARY_THRESHOLD,
  needsSummary,
  readDiffMaxChars,
  readFullDiff,
  type ReadableDiff,
} from "./diff_summary.ts";
import { test } from "node:test";

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

function readable(
  entries: Array<[string, ReadableDiff["state"], string]>,
): Map<string, ReadableDiff> {
  return new Map(
    entries.map(([path, state, patch]) => [path, { state, patch }]),
  );
}

/** A patch of `count` added lines, new-file lines 1..count. */
function added(count: number): string {
  const lines = Array.from({ length: count }, (_, i) => `+line ${i + 1}`);
  return `@@ -0,0 +1,${count} @@\n${lines.join("\n")}`;
}

test("needsSummary triggers only over the threshold with a real patch", () => {
  same(needsSummary(DIFF_SUMMARY_THRESHOLD, "diff"), false, "at threshold");
  same(
    needsSummary(DIFF_SUMMARY_THRESHOLD + 1, "diff"),
    true,
    "over threshold",
  );
  same(needsSummary(10_000, ""), false, "no patch to summarize");
});

test("readFullDiff returns the stored patch for its path, numbered", () => {
  const files = readable([["a.ts", "summarized", "@@ -1 +7 @@\n+real"]]);
  same(
    readFullDiff(files, { path: "a.ts" }),
    "@@ -1 +7 @@\n     7 +real",
    "hit",
  );
});

test("readFullDiff serves partial and dropped files too", () => {
  for (const state of ["partial", "dropped"] as const) {
    const files = readable([["a.ts", state, "@@ -1 +7 @@\n+real"]]);
    same(
      readFullDiff(files, { path: "a.ts" }),
      "@@ -1 +7 @@\n     7 +real",
      state,
    );
  }
});

test("readFullDiff explains an empty set plainly", () => {
  const message = readFullDiff(new Map(), { path: "a.ts" });
  if (!message.includes("Every file's diff is already shown")) {
    throw new Error(`unexpected message: ${message}`);
  }
});

test("readFullDiff lists what is available when the path does not match", () => {
  const files = readable([
    ["a.ts", "summarized", "patch-a"],
    ["b.ts", "dropped", "patch-b"],
    ["c.ts", "full", "patch-c"],
  ]);
  const message = readFullDiff(files, { path: "z.ts" });
  if (!message.includes("a.ts") || !message.includes("b.ts")) {
    throw new Error(`unexpected message: ${message}`);
  }
  if (message.includes("c.ts")) {
    throw new Error(`a full file is not offered: ${message}`);
  }
});

test("readFullDiff points a full file back at the prompt and refuses a withheld one", () => {
  const files = readable([
    ["a.ts", "full", "@@ -1 +1 @@\n+a"],
    ["lock.json", "withheld", ""],
  ]);
  const full = readFullDiff(files, { path: "a.ts" });
  if (!full.includes("already shown")) throw new Error(full);
  const withheld = readFullDiff(files, { path: "lock.json" });
  if (!withheld.includes("no diff text")) throw new Error(withheld);
});

test("offset and limit page through diff lines and keep new-file numbers", () => {
  const files = readable([["a.ts", "partial", added(10)]]);
  // Line 0 is the @@ header, so offset 3 is the third added line.
  same(
    readFullDiff(files, { path: "a.ts", offset: 3, limit: 2 }),
    "     3 +line 3\n     4 +line 4\n[more: call again with offset=5]",
    "page",
  );
  same(
    readFullDiff(files, { path: "a.ts", offset: 9 }),
    "     9 +line 9\n    10 +line 10",
    "last page has no more marker",
  );
});

test("one answer stops at the cap and says where to go on", () => {
  const files = readable([["a.ts", "summarized", added(1000)]]);
  const answer = readFullDiff(files, { path: "a.ts" }, 200);
  const body = answer.slice(0, answer.indexOf("\n[more:"));
  if (body.length > 200) throw new Error(`over the cap: ${body.length}`);
  const next = /\[more: call again with offset=(\d+)\]$/.exec(answer);
  if (!next) throw new Error(`no more marker: ${answer}`);
  const lines = body.split("\n").length;
  same(Number(next[1]), lines, "the next offset follows the last line shown");
  const following = readFullDiff(
    files,
    { path: "a.ts", offset: Number(next[1]) },
    200,
  );
  if (!following.startsWith(`${String(lines).padStart(6)} +line ${lines}`)) {
    throw new Error(`the next page does not continue: ${following}`);
  }
});

test("no cap returns the whole patch, and a single long line is cut to the cap", () => {
  const files = readable([["a.ts", "summarized", added(1000)]]);
  const whole = readFullDiff(files, { path: "a.ts" }, null);
  if (whole.includes("[more:")) throw new Error("no cap must return it all");
  same(whole.split("\n").length, 1001, "every line");
  const long = readable([
    ["b.ts", "partial", `@@ -0,0 +1,2 @@\n+${"y".repeat(500)}\n+short`],
  ]);
  const cut = readFullDiff(long, { path: "b.ts", offset: 1 }, 100);
  same(cut.split("\n")[0]!.length, 100, "cut to the cap");
  same(
    cut.split("\n")[1],
    "[line cut at 100 characters, the rest of this line cannot be read]",
    "the cut is marked",
  );
  if (!cut.endsWith("[more: call again with offset=2]")) throw new Error(cut);
});

test("a long last line is marked as cut even with no more lines after it", () => {
  // A minified bundle: one line of 500,000 characters.
  const files = readable([
    ["bundle.min.js", "dropped", `@@ -0,0 +1 @@\n+${"z".repeat(500_000)}`],
  ]);
  const answer = readFullDiff(files, { path: "bundle.min.js", offset: 1 });
  if (
    !answer.endsWith(
      "[line cut at 20000 characters, the rest of this line cannot be read]",
    )
  ) {
    throw new Error(answer.slice(-200));
  }
  if (answer.includes("[more:")) throw new Error("there is no next line");
  if (answer.length > 20_000 + 100) throw new Error(`size: ${answer.length}`);
});

test("bad paging arguments get a plain answer instead of a throw", () => {
  const files = readable([["a.ts", "partial", added(3)]]);
  for (const args of [
    { path: "a.ts", offset: -1 },
    { path: "a.ts", limit: 0 },
    { path: "a.ts", offset: "x" },
  ]) {
    const answer = readFullDiff(files, args);
    if (!answer.includes("whole number")) throw new Error(answer);
  }
  const past = readFullDiff(files, { path: "a.ts", offset: 50 });
  if (!past.includes("past the end")) throw new Error(past);
});

test("readDiffMaxChars: unset is the default, 0 or below is no limit", () => {
  same(readDiffMaxChars(undefined), DEFAULT_READ_DIFF_MAX_CHARS, "unset");
  same(readDiffMaxChars({}), DEFAULT_READ_DIFF_MAX_CHARS, "empty");
  same(readDiffMaxChars({ reviewReadDiffMaxChars: 5000 }), 5000, "set");
  same(readDiffMaxChars({ reviewReadDiffMaxChars: 0 }), null, "zero");
  same(readDiffMaxChars({ reviewReadDiffMaxChars: -1 }), null, "negative");
});
