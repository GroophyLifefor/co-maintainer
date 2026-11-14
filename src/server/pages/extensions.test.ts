/** The dashboard's view of a review's extensions: results, reasons, media and
 * the markdown, all escaped. */
import { test } from "node:test";
import { buildReport } from "../../extensions/report.ts";
import type { ExtensionResult } from "../../extensions/runner.ts";
import { extensionCostNote, renderExtensionResults } from "./extensions.ts";

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
    durationMs: 0,
    attempts: 1,
    ...overrides,
  };
}

test("results show their outcome, reasons, media, findings and markdown", () => {
  const report = buildReport([
    result({
      name: "qa-vision",
      verdict: "request_changes",
      markdown: "Two **videos**",
      usage: { costUsd: 0.42 },
      data: {
        media: [
          { kind: "video", label: "main", url: "https://cdn.test/main.mp4" },
          { kind: "link", label: "bad", url: "javascript:alert(1)" as string },
        ],
        metrics: [{ name: "cases", value: 4 }],
      },
      findings: [
        {
          severity: "P2",
          blocking: true,
          title: "<b>Snapshot</b> missing",
          body: "b",
          path: "src/a.ts",
          lineFrom: 3,
        },
      ],
    }),
    result({
      name: "lint",
      status: "failed",
      verdict: null,
      reason: "timed out after 10m",
      details: "exit code: 1\nboom",
    }),
    result({
      name: "bench",
      status: "skipped",
      verdict: null,
      reason: "not a pull request",
    }),
  ]);
  const html = renderExtensionResults(report);
  for (const needle of [
    "<b>qa-vision</b>",
    "request_changes · $0.4200",
    '<a href="https://cdn.test/main.mp4"',
    "cases: 4",
    "[P2 · blocking]",
    "&lt;b&gt;Snapshot&lt;/b&gt; missing",
    "src/a.ts:3",
    "<strong>videos</strong>",
    "timed out after 10m",
    "not a pull request",
    "exit code: 1",
  ]) {
    if (!html.includes(needle)) throw new Error(`missing ${needle}\n${html}`);
  }
  if (html.includes('href="javascript:'))
    throw new Error("a script link was drawn");
  if (!extensionCostNote(report).includes("incl. $0.4200 extensions")) {
    throw new Error(extensionCostNote(report));
  }
  if (renderExtensionResults(buildReport([])) !== "") {
    throw new Error("an empty report drew something");
  }
});
