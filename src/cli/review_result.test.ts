import {
  buildLocalReviewJson,
  buildPrReviewJson,
  formatHumanLocalReview,
  formatHumanReview,
  isBlockingFinding,
  reviewCoverageFields,
  reviewExitCodeFromResolved,
  revisionStats,
  sortResolvedFindings,
} from "./review_result.ts";
import type { ResolvedFinding } from "../review/carry_over.ts";
import { fullCoverage, type Coverage } from "../review/coverage.ts";
import type { Revision } from "../review/revision.ts";
import { test } from "node:test";

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

test("isBlockingFinding: non-blocking title is not blocking", () => {
  if (isBlockingFinding("[P2 · non-blocking] `a.ts` — `x`", "P2")) {
    throw new Error("expected false");
  }
});

test("isBlockingFinding: blocking title", () => {
  if (!isBlockingFinding("[P1 · blocking] `a.ts` — `x`", "P1")) {
    throw new Error("expected true");
  }
});

test("reviewExitCodeFromResolved uses open/new blocking only", () => {
  const findings = [
    row({ state: "closed", title: "[P1 · blocking] x" }),
    row({ state: "open", title: "[P2 · non-blocking] x" }),
  ];
  if (reviewExitCodeFromResolved(findings) !== 0) throw new Error("exit 0");
  findings.push(row({ state: "new", title: "[P1 · blocking] y" }));
  if (reviewExitCodeFromResolved(findings) !== 1) throw new Error("exit 1");
});

test("buildPrReviewJson: parses findings from markdown", () => {
  const json = JSON.parse(
    buildPrReviewJson({
      repo: "o/r",
      prNumber: 9,
      markdown:
        "## Findings\n\n### [P2 · non-blocking] `a.ts` — `x`\n\nLocation: a.ts:1\n\nBody",
      guideBuiltAt: "2026-01-01T00:00:00Z",
      codegraphState: "disabled",
      codegraphReason: null,
      usage: { tokensIn: 1, tokensOut: 2, costUsd: 0.01 },
      durationMs: 100,
    }),
  );
  if (json.mode !== "pr" || json.subject.prNumber !== 9) {
    throw new Error(JSON.stringify(json.subject));
  }
  if (json.findings.length !== 1) throw new Error(String(json.findings.length));
});

test("buildPrReviewJson: carried findings keep their state and the summary counts them", () => {
  const json = JSON.parse(
    buildPrReviewJson({
      repo: "o/r",
      prNumber: 9,
      markdown: "",
      findings: [
        row({ state: "new", title: "n" }),
        row({ state: "open", title: "o" }),
        row({ state: "closed", title: "c", closeReason: "fixed" }),
      ],
      warnings: [{ code: "carry_over_unavailable", message: "cache" }],
      guideBuiltAt: null,
      codegraphState: "disabled",
      codegraphReason: null,
      usage: { tokensIn: 1, tokensOut: 2, costUsd: 0.01 },
      durationMs: 100,
    }),
  );
  const { new: fresh, open, closed } = json.summary;
  if (fresh !== 1 || open !== 1 || closed !== 1) {
    throw new Error(JSON.stringify(json.summary));
  }
  if (json.warnings[0]?.code !== "carry_over_unavailable") {
    throw new Error(JSON.stringify(json.warnings));
  }
});

test("sortResolvedFindings: new before open before closed", () => {
  const sorted = sortResolvedFindings([
    row({ state: "closed", title: "c" }),
    row({ state: "new", title: "n" }),
    row({ state: "open", title: "o" }),
  ]);
  if (sorted.map((f) => f.state).join(",") !== "new,open,closed") {
    throw new Error(sorted.map((f) => f.state).join(","));
  }
});

test("formatHumanLocalReview shows guide date (E161)", () => {
  const text = formatHumanLocalReview(
    "header",
    {
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
    },
    "2026-09-15T10:00:00Z",
    "disabled",
    [],
    [],
  );
  if (!text.includes("guide built 2026-09-15")) {
    throw new Error(text);
  }
  // The unified header names the codegraph state too.
  if (!text.includes("codegraph disabled")) {
    throw new Error(text);
  }
});

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

const DROPPED: Coverage = {
  full: 2,
  partial: ["src/big.ts"],
  summarized: [],
  dropped: ["src/z.ts"],
  withheld: [],
};

const REVISION: Revision = {
  files: ["src/a.ts", "src/b.ts", "src/big.ts", "src/z.ts"].map((path) => ({
    path,
    previousPath: null,
    status: "modified" as const,
    binary: false,
    additions: 2,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-a\n+b",
  })),
  title: "",
  description: "",
  baseLabel: "origin/main",
  producer: "local",
};

const DIFF_WARNING = {
  code: "diff_dropped",
  message:
    "1 file was not reviewed because the diff is too large. Run review again to cover it.",
};

test("local --json reports an honest truncated flag, the coverage and the diff warnings", () => {
  const json = JSON.parse(
    buildLocalReviewJson({
      repo: "o/r",
      branch: "feature",
      baseLabel: "origin/main",
      revision: REVISION,
      guideBuiltAt: null,
      codegraphState: "disabled",
      codegraphReason: null,
      findings: [],
      warnings: [
        { code: "carry_over_unavailable", message: "x" },
        DIFF_WARNING,
      ],
      usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
      durationMs: 1,
      coverage: DROPPED,
    }),
  );
  same(
    json.revision,
    {
      files: 4,
      additions: 8,
      deletions: 4,
      truncated: true,
      coverage: DROPPED,
    },
    "revision",
  );
  same(
    json.warnings.map((w: { code: string }) => w.code),
    ["carry_over_unavailable", "diff_dropped"],
    "warnings",
  );
  same(json.schemaVersion, 1, "schema version stays 1");
});

test("PR --json gains revision and warnings, and a diff that fits is not truncated", () => {
  const base = {
    repo: "o/r",
    prNumber: 9,
    markdown: "## Findings\n\nNo actionable findings.\n",
    guideBuiltAt: null,
    codegraphState: "disabled" as const,
    codegraphReason: null,
    usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
    durationMs: 1,
  };
  const dropped = JSON.parse(
    buildPrReviewJson({
      ...base,
      diffStats: { files: 4, additions: 8, deletions: 4 },
      coverage: DROPPED,
      warnings: [DIFF_WARNING],
    }),
  );
  same(dropped.revision.truncated, true, "truncated");
  same(dropped.revision.coverage, DROPPED, "coverage");
  same(dropped.warnings, [DIFF_WARNING], "warnings");
  const fits = JSON.parse(
    buildPrReviewJson({
      ...base,
      diffStats: { files: 3, additions: 3, deletions: 0 },
      coverage: fullCoverage(3),
      warnings: [],
    }),
  );
  same(fits.revision.truncated, false, "fits");
  same(fits.revision.coverage.full, 3, "full count");
  same(fits.warnings, [], "no warnings");
});

test("the remote and push result fields come from the same helper", () => {
  const remote = reviewCoverageFields(REVISION, DROPPED, [DIFF_WARNING]);
  same(remote.revision.truncated, true, "remote truncated");
  same(remote.revision.files, 4, "remote files");
  same(remote.warnings, [DIFF_WARNING], "remote warnings");
  // A push with no changed files runs no review and has no coverage.
  const push = reviewCoverageFields({ ...REVISION, files: [] }, undefined, []);
  same(
    push,
    {
      revision: {
        files: 0,
        additions: 0,
        deletions: 0,
        truncated: false,
        coverage: fullCoverage(0),
      },
      warnings: [],
    },
    "push without a review",
  );
  same(revisionStats(REVISION).truncated, false, "no coverage means full");
});

test("human output prints the coverage line only when a file is not full", () => {
  const input = {
    title: "co-maintainer review",
    guideBuiltAt: null,
    codegraphState: "disabled" as const,
    findings: [],
  };
  const fits = formatHumanReview({ ...input, coverage: fullCoverage(3) });
  if (fits.includes("Coverage:")) throw new Error(fits);
  if (!fits.includes("No actionable findings.\n")) throw new Error(fits);
  const dropped = formatHumanReview({
    ...input,
    coverage: DROPPED,
    warnings: [DIFF_WARNING],
  });
  for (const want of [
    "No actionable findings in the files reviewed.",
    "Coverage: 2 full · 1 partial · 0 summarized · 1 dropped",
    `Warnings:\n  - ${DIFF_WARNING.message}`,
  ]) {
    if (!dropped.includes(want)) throw new Error(`${want}\n${dropped}`);
  }
  const partialOnly = formatHumanReview({
    ...input,
    coverage: { ...DROPPED, dropped: [] },
  });
  if (!partialOnly.includes("No actionable findings.\n")) {
    throw new Error(
      `only a missing file changes the sentence:\n${partialOnly}`,
    );
  }
});
