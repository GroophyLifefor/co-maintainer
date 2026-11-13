/** Every output's view of the extensions, and the two length limits. */
import { test } from "node:test";
import { buildReport, type ExtensionReport } from "./report.ts";
import type { ExtensionResult } from "./runner.ts";
import {
  MAX_INLINE_EXTENSION_COMMENTS,
  reviewBodyWithExtensions,
  splitExtensionFindings,
} from "./render_review.ts";
import {
  JOB_SUMMARY_LIMIT_NOTE,
  JOB_SUMMARY_MAX_BYTES,
  REVIEW_BODY_MAX_CHARS,
  REVIEW_LIMIT_NOTE,
} from "./render_markdown.ts";
import { jobSummaryWithExtensions } from "./render_actions.ts";
import {
  splitRemoteResult,
  stripExtensionMarkdowns,
  usageWithExtensions,
  withExtensionsJson,
} from "./render_json.ts";
import { githubAnnotations, githubSummary } from "../cli/review_github.ts";
import { extensionHumanFindings } from "./render_actions.ts";
import { cliExtensionFooter, cliExtensionLines } from "./render_cli.ts";
import { humanCopy } from "../services/review.ts";
import { outsideCode } from "../util/redact.ts";

function result(overrides: Partial<ExtensionResult>): ExtensionResult {
  return {
    name: "x",
    status: "ok",
    verdict: "comment",
    reason: null,
    markdown: "",
    findings: [],
    data: { media: [], metrics: [] },
    extraData: null,
    usage: null,
    details: null,
    durationMs: 1,
    attempts: 1,
    ...overrides,
  };
}

const AI_BODY =
  "Review summary\n\nNew (1)\n- finding\n\n<details>\n<summary>Metadata</summary>\n\n- Activity: job\n</details>";

test("the review body drops the longest markdown first and never the AI review", () => {
  const report = buildReport([
    result({ name: "big", markdown: "b".repeat(200_000) }),
    result({ name: "medium", markdown: "m".repeat(80_000) }),
    result({ name: "small", markdown: "s".repeat(1_000) }),
  ]);
  const body = reviewBodyWithExtensions(AI_BODY, report, [], (text) => text);
  if (body.length > REVIEW_BODY_MAX_CHARS) throw new Error(`${body.length}`);
  if (body.includes("b".repeat(1000))) throw new Error("the longest stayed");
  if (!body.includes("m".repeat(80_000)))
    throw new Error("medium was dropped too");
  if (!body.includes(REVIEW_LIMIT_NOTE)) throw new Error("no note");
  if (!body.startsWith("Review summary\n\nNew (1)\n- finding")) {
    throw new Error("the AI review changed");
  }
  const huge = buildReport([
    result({ name: "a", markdown: "a".repeat(150_000) }),
    result({ name: "c", markdown: "c".repeat(150_000) }),
  ]);
  const both = reviewBodyWithExtensions(AI_BODY, huge, [], (text) => text);
  if (both.split(REVIEW_LIMIT_NOTE).length !== 2) {
    throw new Error("one removal should have been enough");
  }
});

test("the job summary is capped at 1 MiB in bytes, longest markdown first", () => {
  // Multi-byte text: 400,000 characters of a three-byte letter is 1.2 MB.
  const report = buildReport([
    result({ name: "wide", markdown: "€".repeat(400_000) }),
    result({ name: "narrow", markdown: "n".repeat(300_000) }),
  ]);
  const summary = jobSummaryWithExtensions("## co-maintainer review", report);
  if (Buffer.byteLength(summary) >= JOB_SUMMARY_MAX_BYTES) {
    throw new Error(`${Buffer.byteLength(summary)} bytes`);
  }
  if (!summary.includes(JOB_SUMMARY_LIMIT_NOTE)) throw new Error("no note");
  if (summary.includes("€€€")) throw new Error("the widest stayed");
  if (!summary.includes("n".repeat(300_000))) throw new Error("narrow dropped");
  // 300k characters fit the job summary, which has no 250k cap.
  if (summary.length < REVIEW_BODY_MAX_CHARS) throw new Error("capped at 250k");
});

test("located extension findings are annotated with their label, inside the per level limit", () => {
  const report = buildReport([
    result({
      name: "secret",
      verdict: "request_changes",
      findings: [
        {
          severity: "P1",
          blocking: true,
          title: "Key",
          body: "b",
          path: "a.ts",
          lineFrom: 2,
        },
        { severity: "P2", blocking: false, title: "Nowhere", body: "b" },
      ],
    }),
  ]);
  const rows = extensionHumanFindings(report);
  const lines = githubAnnotations(rows.filter((row) => row.path));
  if (
    lines.length !== 1 ||
    !lines[0]!.startsWith(
      "::error file=a.ts,line=2,title=[P1 · blocking] · extension%3A secret%3A Key::",
    )
  ) {
    throw new Error(lines.join("\n"));
  }
  const many = githubAnnotations(
    Array.from({ length: 12 }, (_, index) => ({
      ...rows[0]!,
      lineFrom: index + 1,
    })),
  );
  if (many.filter((line) => line.startsWith("::error")).length !== 10) {
    throw new Error("the limit of 10 per level was not kept");
  }
  const summary = githubSummary({
    title: "t",
    findings: [],
    extensions: report,
  });
  if (!summary.includes("Nowhere") || !summary.includes("Key")) {
    throw new Error(`the job summary does not list every finding:\n${summary}`);
  }
});

test("--json joins findings with extensionId and keeps markdown only on request", () => {
  const report = buildReport([
    result({
      name: "qa",
      verdict: "request_changes",
      markdown: "**md**",
      usage: { costUsd: 0.4 },
      findings: [{ severity: "P2", blocking: true, title: "t", body: "b" }],
    }),
  ]);
  const doc = withExtensionsJson(
    {
      findings: [{ id: "ai" }],
      summary: { new: 1, open: 0, closed: 0, blocking: 0 },
      usage: { costUsd: 0.1 },
    },
    report,
  );
  const findings = doc.findings as {
    extensionId: string | null;
    blocking?: boolean;
  }[];
  if (findings[0]?.extensionId !== null || findings[1]?.extensionId !== "qa") {
    throw new Error(JSON.stringify(findings));
  }
  if (
    findings[1]?.blocking !== true ||
    doc.summary.blocking !== 1 ||
    doc.summary.new !== 2
  ) {
    throw new Error(JSON.stringify(doc.summary));
  }
  const entry = (doc.extensions as { id: string; markdown: string }[])[0]!;
  if (entry.id !== "qa" || entry.markdown !== "")
    throw new Error(JSON.stringify(entry));
  const usage = doc.usage as unknown as Record<string, number>;
  if (
    Math.abs(usage.costUsd! - 0.5) > 1e-9 ||
    usage.reviewCostUsd !== 0.1 ||
    usage.extensionsCostUsd !== 0.4
  ) {
    throw new Error(JSON.stringify(usage));
  }
  if (usageWithExtensions({ costUsd: null }, report).costUsd !== null) {
    throw new Error("an unknown review cost became known");
  }
  const withMd = withExtensionsJson(
    { findings: [], summary: { new: 0, open: 0, closed: 0, blocking: 0 } },
    report,
    true,
  );
  if ((withMd.extensions as { markdown: string }[])[0]!.markdown !== "**md**") {
    throw new Error("markdown was not kept");
  }
});

test("a verdict wins over a finding's own blocking flag", () => {
  const report: ExtensionReport = buildReport([
    result({
      name: "lint",
      verdict: "comment",
      findings: [{ severity: "P0", blocking: true, title: "t", body: "b" }],
    }),
  ]);
  const lines = cliExtensionLines(report).join("\n");
  if (!lines.includes("[P0 · non-blocking] t")) throw new Error(lines);
});

test("the CLI block names failures with their reason and lists media", () => {
  const report = buildReport([
    result({
      name: "qa-vision",
      verdict: "request_changes",
      data: {
        media: [
          { kind: "video", label: "main", url: "https://cdn.test/1" },
          { kind: "video", label: "pr", url: "https://cdn.test/2" },
        ],
        metrics: [],
      },
    }),
    result({
      name: "lint",
      status: "failed",
      verdict: null,
      reason: "timed out after 10m",
    }),
    result({
      name: "bench",
      status: "skipped",
      verdict: null,
      reason: "not a pr",
    }),
  ]);
  const lines = cliExtensionLines(report).join("\n");
  for (const needle of [
    "  qa-vision · request_changes",
    "    video main: https://cdn.test/1",
    "    video pr:   https://cdn.test/2",
    "  lint · failed: timed out after 10m",
    "  bench · skipped: not a pr",
  ]) {
    if (!lines.includes(needle)) throw new Error(`${needle}\n${lines}`);
  }
  if (
    cliExtensionFooter(report) !==
    "Extensions: qa-vision · Failed: lint · Skipped: bench"
  ) {
    throw new Error(cliExtensionFooter(report));
  }
});

test("a remote result splits back into AI findings and extensions", () => {
  const remote = {
    findings: [
      { id: "1", extensionId: null, title: "ai" },
      {
        id: "2",
        extensionId: "qa",
        title: "ext",
        severity: "P1",
        blocking: true,
        state: "open",
      },
    ],
    extensions: [
      {
        id: "qa",
        status: "ok",
        verdict: "request_changes",
        markdown: "m",
        data: { media: [], metrics: [] },
      },
    ],
  };
  const { aiFindings, report } = splitRemoteResult(remote);
  if (aiFindings.length !== 1 || report.findings[0]?.state !== "open") {
    throw new Error(JSON.stringify({ aiFindings, report }));
  }
  const stripped = stripExtensionMarkdowns(remote, false);
  if ((stripped.extensions as { markdown: string }[])[0]!.markdown !== "") {
    throw new Error("markdown kept without the flag");
  }
  const old = splitRemoteResult({ findings: [{ id: "1", title: "ai" }] });
  if (old.report.results.length !== 0 || old.aiFindings.length !== 1) {
    throw new Error("an older server's result was misread");
  }
});

/** The check `publish` runs on everything it posts. */
function forbidden(text: string): boolean {
  return outsideCode(text, (prose) => prose.replaceAll(";", "")) !== text;
}

test("a fence in a title and code in the markdown still pass the copy check together", () => {
  const report = buildReport([
    result({
      name: "lint",
      markdown: "Example:\n\n```\nconst a = 1;\n```",
      findings: [
        { severity: "P2", blocking: false, title: "Use ``` fences", body: "b" },
        {
          severity: "P2",
          blocking: false,
          title: "Odd `tick",
          body: "```\nopen fence; never closed",
          path: "a.ts",
          lineFrom: 1,
        },
      ],
    }),
  ]);
  const files = [{ filename: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b" }];
  const split = splitExtensionFindings(report, files, humanCopy);
  const body = reviewBodyWithExtensions(
    AI_BODY,
    report,
    split.listed,
    humanCopy,
  );
  if (forbidden(body)) throw new Error(`publish would refuse:\n${body}`);
  for (const comment of split.comments) {
    if (forbidden(comment.body)) throw new Error(comment.body);
  }
  if (!body.includes("const a = 1;")) throw new Error("the code was changed");
});

test("thousands of findings: inline comments are capped and the body fits with an and-more line", () => {
  const many = (located: boolean) =>
    buildReport([
      result({
        name: "lint",
        markdown: "m".repeat(100_000),
        findings: Array.from({ length: 5_000 }, (_, index) => ({
          severity: "P3" as const,
          blocking: false,
          title: `Finding ${index} ${"t".repeat(300)}`,
          body: "b".repeat(10_000),
          ...(located ? { path: "a.ts", lineFrom: 1 } : {}),
        })),
      }),
    ]);
  const files = [{ filename: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b" }];
  const onDiff = many(true);
  const split = splitExtensionFindings(onDiff, files, (text) => text);
  if (split.comments.length !== MAX_INLINE_EXTENSION_COMMENTS) {
    throw new Error(`${split.comments.length} inline comments`);
  }
  if (split.comments.some((comment) => comment.body.length > 5_000)) {
    throw new Error("an inline body was not cut");
  }
  const offDiff = many(false);
  const listed = splitExtensionFindings(offDiff, files, (text) => text).listed;
  const body = reviewBodyWithExtensions(AI_BODY, offDiff, listed, (t) => t);
  if (body.length > REVIEW_BODY_MAX_CHARS) throw new Error(`${body.length}`);
  if (!body.includes("- and 4950 more, see the dashboard")) {
    throw new Error(body.slice(0, 2_000));
  }
  if (!body.startsWith("Review summary\n\nNew (1)\n- finding")) {
    throw new Error("the AI review changed");
  }
  // A body that only fits with a shorter list still keeps the AI review.
  const tight = reviewBodyWithExtensions(
    `${"A".repeat(240_000)}${AI_BODY}`,
    offDiff,
    listed,
    (t) => t,
  );
  if (
    tight.length > REVIEW_BODY_MAX_CHARS ||
    !tight.startsWith("A".repeat(240_000))
  ) {
    throw new Error(`tight body ${tight.length}`);
  }
  if (!tight.includes("more, see the dashboard"))
    throw new Error("no and-more line");
});
