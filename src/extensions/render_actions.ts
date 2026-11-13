/** The extensions in `review --output=github`.
 *
 * A finding with a location becomes an annotation with the extension label,
 * inside the same 10 per level GitHub shows. The job summary lists every
 * finding and carries each extension's `markdown`. The 250k cap of a GitHub
 * review does not apply: there is no dashboard in this mode, so a `markdown`
 * dropped at that size would be lost. The job summary's own 1 MiB limit does,
 * and the longest `markdown` goes first. */
import { stripControlChars } from "../util/sanitize.ts";
import type { HumanFinding } from "../cli/review_result.ts";
import {
  effectiveBlocking,
  extensionLabel,
  type ExtensionReport,
} from "./report.ts";
import {
  extensionsSection,
  fitMarkdowns,
  JOB_SUMMARY_LIMIT_NOTE,
  JOB_SUMMARY_MAX_BYTES,
  utf8Bytes,
} from "./render_markdown.ts";

export function extensionHumanFindings(
  report: ExtensionReport | undefined,
): HumanFinding[] {
  if (!report) return [];
  return report.findings.map((row) => ({
    state: row.state,
    severity: row.severity,
    blocking: effectiveBlocking(report, row),
    path: row.path,
    lineFrom: row.lineFrom,
    lineTo: row.lineTo,
    title: row.title,
    body: row.body,
    suggestion: null,
    label: extensionLabel(report, row),
  }));
}

/** The lines naming each extension that did not return `ok`, with its reason.
 * In the CLI the reason is shown directly. */
function outcomeLines(report: ExtensionReport): string[] {
  return report.results
    .filter((result) => result.status !== "ok")
    .map(
      (result) =>
        `- ${stripControlChars(result.name)} ${result.status}: ${stripControlChars(result.reason ?? "").replace(/\s+/g, " ")}`,
    );
}

/** The job summary with the extensions' part added after the AI part, cut to
 * the 1 MiB limit by dropping `markdown`, longest first. */
export function jobSummaryWithExtensions(
  aiSummary: string,
  report: ExtensionReport | undefined,
): string {
  if (!report || report.results.length === 0) return aiSummary;
  const outcomes = outcomeLines(report);
  return fitMarkdowns(
    report,
    (markdowns) =>
      [
        aiSummary,
        ...(outcomes.length > 0 ? ["", ...outcomes] : []),
        ...(markdowns.size > 0
          ? ["", extensionsSection(report, markdowns)]
          : []),
      ].join("\n"),
    // The summary file is appended with a newline.
    JOB_SUMMARY_MAX_BYTES - 1,
    utf8Bytes,
    JOB_SUMMARY_LIMIT_NOTE,
  );
}
