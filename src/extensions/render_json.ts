/** The extensions in `review --json`, in the remote result, and in the cost
 * line.
 *
 * `extensions[]` holds each result. Extension findings join the top-level
 * `findings[]` with `extensionId`, and AI findings carry `extensionId: null`,
 * so a reader tells them apart without a second list. `markdown` is empty
 * unless `--include-extension-markdowns` asks for it: it is written for GitHub
 * and can be large. */
import {
  effectiveBlocking,
  EMPTY_REPORT,
  extensionsCostUsd,
  hasExtensions,
  type ExtensionReport,
} from "./report.ts";
import { extensionCounts } from "./render_cli.ts";
import type { RunSummary } from "../util/run_summary.ts";

type Counts = { new: number; open: number; closed: number; blocking: number };

export function jsonExtensionResults(
  report: ExtensionReport,
  includeMarkdown: boolean,
): unknown[] {
  return report.results.map((result) => ({
    id: result.name,
    status: result.status,
    verdict: result.verdict,
    reason: result.reason,
    markdown: includeMarkdown ? result.markdown : "",
    data: result.data,
    extraData: result.extraData,
    usage: result.usage,
    durationMs: result.durationMs,
  }));
}

export function jsonExtensionFindings(report: ExtensionReport): unknown[] {
  return report.findings.map((row) => ({
    id: row.id,
    state: row.state,
    closeReason: null,
    severity: row.severity,
    blocking: effectiveBlocking(report, row),
    path: row.path,
    lineFrom: row.lineFrom,
    lineTo: row.lineTo,
    title: row.title,
    body: row.body,
    suggestion: null,
    extensionId: row.extensionId,
    key: row.key,
  }));
}

/** `usage` with the extensions' cost joined in. `costUsd` is the total,
 * `reviewCostUsd` the AI review alone. An unknown review cost keeps the total
 * unknown. Unchanged when no extension ran. */
export function usageWithExtensions<
  T extends { costUsd: number | null } | undefined,
>(usage: T, report: ExtensionReport = EMPTY_REPORT): T {
  if (!usage || !hasExtensions(report)) return usage;
  const extensions = extensionsCostUsd(report);
  return {
    ...usage,
    costUsd: usage.costUsd === null ? null : usage.costUsd + extensions,
    reviewCostUsd: usage.costUsd,
    extensionsCostUsd: extensions,
  };
}

/** The terminal's cost line with the extensions' cost in the total. */
export function runSummaryWithExtensions(
  summary: RunSummary,
  report: ExtensionReport = EMPTY_REPORT,
): RunSummary {
  if (!hasExtensions(report) || summary.costUsd === null) return summary;
  return { ...summary, costUsd: summary.costUsd + extensionsCostUsd(report) };
}

/** Adds the extensions to a review JSON document: their findings, their
 * counts in `summary`, their results and their cost. */
export function withExtensionsJson<
  T extends {
    findings: object[];
    summary: Counts;
    usage?: { costUsd: number | null };
  },
>(
  doc: T,
  report: ExtensionReport = EMPTY_REPORT,
  includeMarkdown = false,
): T & { extensions: unknown[] } {
  const extra = extensionCounts(report);
  return {
    ...doc,
    summary: {
      new: doc.summary.new + extra.new,
      open: doc.summary.open + extra.open,
      closed: doc.summary.closed + extra.closed,
      blocking: doc.summary.blocking + extra.blocking,
    },
    findings: [
      ...doc.findings.map((row) => ({ ...row, extensionId: null })),
      ...jsonExtensionFindings(report),
    ],
    extensions: jsonExtensionResults(report, includeMarkdown),
    ...(doc.usage ? { usage: usageWithExtensions(doc.usage, report) } : {}),
  };
}

/** A remote result arrives with every `markdown`. The client empties them
 * unless it was asked for them, the same as a local `--json`. */
export function stripExtensionMarkdowns(
  result: Record<string, unknown>,
  includeMarkdown: boolean,
): Record<string, unknown> {
  if (includeMarkdown || !Array.isArray(result.extensions)) return result;
  return {
    ...result,
    extensions: (result.extensions as Record<string, unknown>[]).map(
      (entry) => ({ ...entry, markdown: "" }),
    ),
  };
}

/** Whether a remote result's extensions make the review blocking. */
export function jsonExtensionsBlock(result: Record<string, unknown>): boolean {
  if (!Array.isArray(result.extensions)) return false;
  return (result.extensions as { status?: string; verdict?: string }[]).some(
    (entry) => entry.status === "ok" && entry.verdict === "request_changes",
  );
}
