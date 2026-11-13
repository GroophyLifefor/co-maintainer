import { test } from "node:test";
import {
  coverageFromJson,
  coverageFromResult,
  coverageLine,
  coverageTruncated,
  coverageWarnings,
  fullCoverage,
  notReviewedLines,
  warningsFromJson,
  type Coverage,
} from "./coverage.ts";

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

const SAMPLE: Coverage = {
  full: 58,
  partial: ["src/store/reads.ts"],
  summarized: ["src/api/routes.ts", "src/store/schema.ts"],
  dropped: [],
  withheld: [],
};

test("truncated is true only when a file was not full", () => {
  same(coverageTruncated(fullCoverage(3)), false, "all full");
  same(coverageTruncated(SAMPLE), true, "partial and summarized");
  same(
    coverageTruncated({ ...fullCoverage(1), withheld: ["lock.json"] }),
    true,
    "withheld",
  );
});

test("the coverage line appears only when a file is not full", () => {
  same(coverageLine(fullCoverage(3)), null, "all full");
  same(coverageLine(undefined), null, "unknown");
  same(
    coverageLine({ ...SAMPLE, dropped: ["a.ts"] }),
    "Coverage: 58 full · 1 partial · 2 summarized · 1 dropped",
    "line",
  );
  same(
    coverageLine({ ...fullCoverage(2), withheld: ["lock.json"] }),
    "Coverage: 2 full · 0 partial · 0 summarized · 0 dropped · 1 withheld",
    "withheld only when present",
  );
});

test("warnings name dropped, withheld and failed files with their codes", () => {
  const warnings = coverageWarnings(
    {
      ...fullCoverage(1),
      partial: ["x.ts"],
      dropped: Array.from({ length: 14 }, (_, i) => `d${i}.ts`),
      withheld: ["package-lock.json"],
    },
    ["x.ts"],
  );
  same(
    warnings.map((warning) => warning.code),
    ["diff_dropped", "diff_withheld", "summary_failed"],
    "codes",
  );
  same(
    warnings[0]!.message,
    "14 files were not reviewed because the diff is too large. Run review again to cover them.",
    "dropped",
  );
  same(
    warnings[1]!.message,
    "1 file was not reviewed because GitHub sent no diff for it.",
    "withheld",
  );
  if (!warnings[2]!.message.includes("x.ts")) throw new Error("failed path");
  same(coverageWarnings(SAMPLE), [], "no warning for partial or summarized");
});

test("warning text has no semicolon and no em dash", () => {
  const warnings = coverageWarnings(
    {
      ...fullCoverage(1),
      dropped: ["a.ts"],
      withheld: ["b.ts", "c.ts"],
    },
    ["d.ts", "e.ts", "f.ts", "g.ts", "h.ts", "i.ts"],
  );
  for (const { message } of warnings) {
    if (message.includes(";") || message.includes("—")) {
      throw new Error(message);
    }
  }
});

test("the not-reviewed list is cut at 20 entries", () => {
  const coverage: Coverage = {
    ...fullCoverage(0),
    dropped: Array.from({ length: 24 }, (_, i) => `src/f${i}.ts`),
    withheld: ["package-lock.json"],
  };
  const lines = notReviewedLines(coverage);
  same(lines[0], "Not reviewed (25)", "heading");
  same(lines[1], "- src/f0.ts: the diff was too large for this round", "row");
  same(lines.length, 1 + 20 + 1, "heading, 20 rows and the rest");
  same(lines.at(-1), "- and 5 more", "rest");
  const short = notReviewedLines({
    ...fullCoverage(0),
    withheld: ["package-lock.json"],
  });
  same(
    short,
    ["Not reviewed (1)", "- package-lock.json: GitHub sent no diff"],
    "withheld row",
  );
  same(notReviewedLines(SAMPLE), [], "nothing missing");
});

test("a coverage block from an older or broken server is ignored", () => {
  same(coverageFromJson(undefined), undefined, "absent");
  same(coverageFromJson({ full: "3" }), undefined, "wrong type");
  same(
    coverageFromJson({ full: 1, partial: [], summarized: [], dropped: [1] }),
    undefined,
    "bad list",
  );
  same(coverageFromJson(SAMPLE), SAMPLE, "valid");
  same(coverageFromResult({ revision: { files: 3 } }), undefined, "old server");
  same(coverageFromResult({ revision: { coverage: SAMPLE } }), SAMPLE, "new");
});

test("server warnings are read defensively and stripped of control characters", () => {
  same(warningsFromJson(undefined), [], "absent");
  same(
    warningsFromJson([
      { code: "diff_dropped", message: "2 files\u001b[2J were not" },
      { code: 3 },
      "x",
    ]),
    [{ code: "diff_dropped", message: "2 files[2J were not" }],
    "parsed",
  );
});
