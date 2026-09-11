/** Round detection and repeat matching for P11 re-reviews.
 * Rounds are clusters of review comments that share `original_commit_id`,
 * oldest first, the same grouping benchmark/README.md describes. */
import type { FindingRow } from "../store/rows.ts";
import type { Span } from "./findings.ts";

export type RoundComment = {
  original_commit_id?: string;
  commit_id?: string;
  created_at?: string;
};

export function reviewRounds(comments: RoundComment[]): string[] {
  const sorted = [...comments].sort((a, b) =>
    String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))
  );
  const rounds: string[] = [];
  const seen = new Set<string>();
  for (const comment of sorted) {
    const id = comment.original_commit_id || comment.commit_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rounds.push(id);
  }
  return rounds;
}

/** Previous round's commit: the last clustered original_commit_id that is
 * not the current head. Undefined when there is no earlier round. */
export function incrementalBase(
  rounds: string[],
  headSha: string,
): string | undefined {
  const previous = rounds.filter((sha) => sha !== headSha);
  return previous.at(-1);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function asSpan(row: FindingRow): Span | undefined {
  if (!row.path || row.line_from == null) return undefined;
  return {
    path: row.path,
    from: row.line_from,
    to: row.line_to ?? row.line_from,
  };
}

export function spansOverlap(a: Span, b: Span): boolean {
  if (normalizePath(a.path) !== normalizePath(b.path)) return false;
  return a.from <= b.to && b.from <= a.to;
}

/** First previous finding that covers the same path and line. */
export function matchRepeat(
  finding: Span,
  previous: FindingRow[],
): FindingRow | undefined {
  return previous.find((row) => {
    const span = asSpan(row);
    return span !== undefined && spansOverlap(finding, span);
  });
}
