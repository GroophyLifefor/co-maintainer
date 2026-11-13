/** What a review's model actually received, file by file, and the words every
 * output uses to say so. The states come from the diff plan in
 * `src/pr/diff_plan.ts`. This file only counts and words them, so the
 * terminal, `--json`, `--output=github` and the GitHub review cannot drift
 * into different stories about the same run. */
import { stripControlChars } from "../util/sanitize.ts";

/** `full` is a count, every other state names its files. */
export type Coverage = {
  full: number;
  partial: string[];
  summarized: string[];
  dropped: string[];
  withheld: string[];
};

export type CoverageWarning = { code: string; message: string };

/** A review that never ran a diff plan, such as a push with no changed files,
 * saw every one of its files in full. */
export function fullCoverage(files: number): Coverage {
  return {
    full: files,
    partial: [],
    summarized: [],
    dropped: [],
    withheld: [],
  };
}

/** True when any file reached the model as less than its whole patch. */
export function coverageTruncated(coverage: Coverage): boolean {
  return (
    coverage.partial.length > 0 ||
    coverage.summarized.length > 0 ||
    coverage.dropped.length > 0 ||
    coverage.withheld.length > 0
  );
}

/** Files the model never received at all. Findings can only speak for the
 * other files. */
export function coverageMissing(coverage: Coverage): number {
  return coverage.dropped.length + coverage.withheld.length;
}

/** `58 full · 1 partial · 3 summarized · 0 dropped`, with the withheld count
 * only when there is one, since only a pull request review can have it. */
export function coverageCounts(coverage: Coverage): string {
  const parts = [
    `${coverage.full} full`,
    `${coverage.partial.length} partial`,
    `${coverage.summarized.length} summarized`,
    `${coverage.dropped.length} dropped`,
  ];
  if (coverage.withheld.length > 0) {
    parts.push(`${coverage.withheld.length} withheld`);
  }
  return parts.join(" · ");
}

/** The terminal's coverage line, or `null` when every file was full. */
export function coverageLine(coverage: Coverage | undefined): string | null {
  if (!coverage || !coverageTruncated(coverage)) return null;
  return `Coverage: ${coverageCounts(coverage)}`;
}

function files(count: number): string {
  return count === 1 ? "1 file was" : `${count} files were`;
}

/** The warnings a diff plan leaves behind, in the order a reader needs them:
 * what was not reviewed first, then what was reviewed from less text than
 * planned. */
export function coverageWarnings(
  coverage: Coverage,
  summaryFailed: string[] = [],
): CoverageWarning[] {
  const warnings: CoverageWarning[] = [];
  const dropped = coverage.dropped.length;
  if (dropped > 0) {
    warnings.push({
      code: "diff_dropped",
      message: `${files(dropped)} not reviewed because the diff is too large. Run review again to cover ${dropped === 1 ? "it" : "them"}.`,
    });
  }
  const withheld = coverage.withheld.length;
  if (withheld > 0) {
    warnings.push({
      code: "diff_withheld",
      message: `${files(withheld)} not reviewed because GitHub sent no diff for ${withheld === 1 ? "it" : "them"}.`,
    });
  }
  if (summaryFailed.length === 1) {
    warnings.push({
      code: "summary_failed",
      message: `The summary of ${summaryFailed[0]} failed, so the review saw its diff instead, up to the first 12,000 characters.`,
    });
  } else if (summaryFailed.length > 1) {
    const shown = summaryFailed.slice(0, 5).join(", ");
    const more =
      summaryFailed.length > 5 ? ` and ${summaryFailed.length - 5} more` : "";
    warnings.push({
      code: "summary_failed",
      message: `The summaries of ${summaryFailed.length} files failed, so the review saw their diffs instead, up to the first 12,000 characters each: ${shown}${more}.`,
    });
  }
  return warnings;
}

/** At most this many files are named in a not-reviewed list. */
export const NOT_REVIEWED_LIST_LIMIT = 20;

/** The `Not reviewed (N)` list for a GitHub review or a job summary, empty
 * when every file reached the model. `formatPath` lets each caller escape a
 * path for where it lands. */
export function notReviewedLines(
  coverage: Coverage | undefined,
  formatPath: (path: string) => string = (path) => path,
): string[] {
  if (!coverage || coverageMissing(coverage) === 0) return [];
  const rows = [
    ...coverage.dropped.map(
      (path) => `- ${formatPath(path)}: the diff was too large for this round`,
    ),
    ...coverage.withheld.map(
      (path) => `- ${formatPath(path)}: GitHub sent no diff`,
    ),
  ];
  const shown = rows.slice(0, NOT_REVIEWED_LIST_LIMIT);
  if (rows.length > shown.length) {
    shown.push(`- and ${rows.length - shown.length} more`);
  }
  return [`Not reviewed (${rows.length})`, ...shown];
}

function pathList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string")) return undefined;
  return value.map((item) => stripControlChars(item));
}

/** A coverage block read from a remote server's result. A server older than
 * this field sends none, and a malformed block is treated the same way, so
 * the client never prints a claim it cannot check. */
export function coverageFromJson(value: unknown): Coverage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const full = raw.full;
  if (typeof full !== "number" || !Number.isFinite(full) || full < 0) {
    return undefined;
  }
  const partial = pathList(raw.partial);
  const summarized = pathList(raw.summarized);
  const dropped = pathList(raw.dropped);
  const withheld = pathList(raw.withheld);
  if (!partial || !summarized || !dropped || !withheld) return undefined;
  return { full, partial, summarized, dropped, withheld };
}

/** The coverage inside a remote result's `revision` block. */
export function coverageFromResult(
  result: Record<string, unknown>,
): Coverage | undefined {
  const revision = result.revision;
  if (!revision || typeof revision !== "object") return undefined;
  return coverageFromJson((revision as Record<string, unknown>).coverage);
}

/** Warnings read from a remote server's result, with the same tolerance as
 * `coverageFromJson`: an older server sends no list. */
export function warningsFromJson(value: unknown): CoverageWarning[] {
  if (!Array.isArray(value)) return [];
  const warnings: CoverageWarning[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { code, message } = item as Record<string, unknown>;
    if (typeof code !== "string" || typeof message !== "string") continue;
    warnings.push({
      code: stripControlChars(code),
      message: stripControlChars(message),
    });
  }
  return warnings;
}
