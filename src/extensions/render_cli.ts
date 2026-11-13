/** The extensions in the terminal. Built from `findings` and `data`, never
 * from `markdown`, which is written for GitHub.
 *
 *   Extensions
 *     qa-vision · request_changes
 *       • [P2 · blocking] Snapshot button missing
 *       video main: https://...
 *       video pr:   https://...
 *
 *   Extensions: qa-vision · Failed: none
 *
 * Everything an extension wrote is untrusted text, so control characters are
 * stripped before it reaches the terminal. */
import { stripControlChars } from "../util/sanitize.ts";
import {
  effectiveBlocking,
  namesWith,
  type ExtensionFinding,
  type ExtensionReport,
} from "./report.ts";

function clean(text: string): string {
  return stripControlChars(text.replace(/\s*\n\s*/g, " ")).trim();
}

export function locationOf(finding: {
  path: string | null;
  lineFrom: number | null;
  lineTo: number | null;
}): string {
  if (!finding.path) return "";
  if (!finding.lineFrom) return finding.path;
  const to = finding.lineTo ?? finding.lineFrom;
  return to === finding.lineFrom
    ? `${finding.path}:${finding.lineFrom}`
    : `${finding.path}:${finding.lineFrom}-${to}`;
}

function findingLine(report: ExtensionReport, row: ExtensionFinding): string {
  const label = `[${row.severity} · ${
    effectiveBlocking(report, row) ? "blocking" : "non-blocking"
  }]`;
  const where = locationOf(row);
  const bullet = row.state === "closed" ? "✓" : "•";
  const state =
    row.state === "closed"
      ? " (closed)"
      : row.state === "open"
        ? " (still open)"
        : "";
  return `    ${bullet} ${where ? `${clean(where)}  ` : ""}${label} ${clean(row.title)}${state}`;
}

/** The `Extensions` block, or nothing when no extension ran. */
export function cliExtensionLines(report: ExtensionReport): string[] {
  if (report.results.length === 0) return [];
  const lines = ["Extensions"];
  for (const result of report.results) {
    const outcome =
      result.status === "ok"
        ? (result.verdict ?? "ok")
        : `${result.status}: ${clean(result.reason ?? "")}`;
    lines.push(`  ${clean(result.name)} · ${outcome}`);
    for (const row of report.findings.filter(
      (finding) => finding.extensionId === result.name,
    )) {
      lines.push(findingLine(report, row));
    }
    const media = result.data.media;
    const width = Math.max(0, ...media.map((item) => clean(item.label).length));
    for (const item of media) {
      lines.push(
        `    ${clean(item.kind)} ${`${clean(item.label)}:`.padEnd(width + 1)} ${clean(item.url)}`,
      );
    }
    for (const metric of result.data.metrics) {
      lines.push(
        `    ${clean(metric.name)}: ${metric.value}${metric.unit ? ` ${clean(metric.unit)}` : ""}`,
      );
    }
  }
  return lines;
}

function list(names: string[]): string {
  return names.length === 0 ? "none" : names.map(clean).join(", ");
}

/** `Extensions: qa-vision · Failed: none`, with the skipped ones when there
 * are any. */
export function cliExtensionFooter(report: ExtensionReport): string {
  if (report.results.length === 0) return "";
  const skipped = namesWith(report, "skipped");
  return [
    `Extensions: ${list(namesWith(report, "ok"))}`,
    `Failed: ${list(namesWith(report, "failed"))}`,
    ...(skipped.length > 0 ? [`Skipped: ${list(skipped)}`] : []),
  ].join(" · ");
}
