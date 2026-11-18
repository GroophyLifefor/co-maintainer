/** The Usage export: one CSV row per review the page counts. */
import type { UsageExportRow } from "../../store/reviews.ts";

export const USAGE_CSV_COLUMNS = [
  "time",
  "repository",
  "pull_request",
  "author",
  "model",
  "tokens_in",
  "tokens_out",
  "cost_usd",
  "billed_to",
  "findings",
  "status",
];

/** A cell a spreadsheet will not read as a formula, quoted when it holds a
 * comma, a quote or a line break. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The status column says what happened in words a sheet can filter on. A
 * CLI review is named as one, whatever its status. */
function statusOf(row: UsageExportRow): string {
  if (row.kind === "remote") return `cli ${row.status}`;
  if (row.kind === "push") return `push ${row.status}`;
  return row.status;
}

export function usageCsv(rows: UsageExportRow[]): string {
  const lines = [USAGE_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const known =
      (row.cost_status ?? (row.cost !== null ? "known" : "unknown")) ===
      "known";
    lines.push(
      [
        cell(row.created_at),
        cell(row.repo),
        cell(row.pr_number),
        cell(row.author),
        cell(row.model),
        cell(row.tokens_in),
        cell(row.tokens_out),
        // An unknown cost is an empty cell, never a zero that reads as free.
        known ? cell(row.cost ?? 0) : "",
        cell(row.billed_to ?? "server"),
        cell(row.findings_count),
        cell(statusOf(row)),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
