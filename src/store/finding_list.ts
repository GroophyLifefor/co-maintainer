/** The Findings lists: every finding of every reviewed pull request, one row
 * per finding. A finding carried from round to round is stored again in each
 * round. Only its newest copy is listed, so its state is the one it has now
 * and a finding open for three rounds is one row, not three. */
import { getAppDb } from "./app_db.ts";
import type { FindingRow } from "./rows.ts";

export type FindingFilter = {
  repo?: string;
  /** `P0` to `P3`. */
  severity?: string;
  state?: "open" | "closed" | "all";
  pr?: number;
  /** Part of the file path. */
  file?: string;
  /** Words in the title or the body. */
  q?: string;
  /** Only findings from reviews at or after this time. */
  sinceIso?: string;
};

export type FindingListRow = FindingRow & {
  repo: string;
  pr_number: number;
  round: number;
  head_sha: string | null;
  reviewed_at: string;
  pr_title: string | null;
};

/** `LIKE` treats `%` and `_` as wildcards. A search for `a_b` means the text
 * itself, so both are escaped. */
function likeText(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function whereOf(filter: FindingFilter): {
  sql: string;
  params: (string | number)[];
} {
  // A repository removed from the dashboard has no pages to link to.
  const where = [
    "r.kind = 'pr'",
    "r.repo IN (SELECT full_name FROM repos WHERE active = 1)",
    "NOT EXISTS (SELECT 1 FROM findings c WHERE c.carried_from_finding_id = f.id)",
  ];
  const params: (string | number)[] = [];
  if (filter.repo) {
    where.push("r.repo = ?");
    params.push(filter.repo);
  }
  if (filter.severity) {
    where.push("f.severity = ?");
    params.push(filter.severity);
  }
  if (filter.state === "open") where.push("f.state != 'closed'");
  if (filter.state === "closed") where.push("f.state = 'closed'");
  if (filter.pr) {
    where.push("r.pr_number = ?");
    params.push(filter.pr);
  }
  if (filter.file) {
    where.push("f.path LIKE ? ESCAPE '\\'");
    params.push(likeText(filter.file));
  }
  if (filter.q) {
    where.push("(f.title LIKE ? ESCAPE '\\' OR f.body_md LIKE ? ESCAPE '\\')");
    params.push(likeText(filter.q), likeText(filter.q));
  }
  if (filter.sinceIso) {
    where.push("r.created_at >= ?");
    params.push(filter.sinceIso);
  }
  return { sql: where.join(" AND "), params };
}

export function listFindingsPage(
  filter: FindingFilter,
  limit: number,
  offset: number,
): { items: FindingListRow[]; total: number } {
  const { sql, params } = whereOf(filter);
  const total = Number(
    getAppDb()
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM findings f
       INNER JOIN reviews r ON r.id = f.review_id
       WHERE ${sql}`,
      )
      .get(...params)?.n ?? 0,
  );
  const items = getAppDb()
    .prepare<FindingListRow>(
      `SELECT f.*, r.repo AS repo, r.pr_number AS pr_number, r.round AS round,
        r.head_sha AS head_sha, r.created_at AS reviewed_at, t.title AS pr_title
     FROM findings f
     INNER JOIN reviews r ON r.id = f.review_id
     LEFT JOIN pull_titles t ON t.repo = r.repo AND t.pr_number = r.pr_number
     WHERE ${sql}
     ORDER BY r.created_at DESC, f.severity, f.id
     LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  return { items, total };
}

/** How many findings the list would show, by severity, for a stat card whose
 * numbers must match the list they open. */
export function countFindingsBySeverity(
  filter: FindingFilter,
): { severity: string; findings: number }[] {
  const { sql, params } = whereOf(filter);
  return getAppDb()
    .prepare<{ severity: string; findings: number }>(
      `SELECT f.severity AS severity, COUNT(*) AS findings
     FROM findings f
     INNER JOIN reviews r ON r.id = f.review_id
     WHERE ${sql}
     GROUP BY f.severity
     ORDER BY f.severity`,
    )
    .all(...params)
    .map((row) => ({
      severity: String(row.severity),
      findings: Number(row.findings),
    }));
}

/** The repositories that have at least one listed finding, for the
 * repository filter on the all-repositories list. */
export function repositoriesWithFindings(): string[] {
  return getAppDb()
    .prepare<{ repo: string }>(
      `SELECT DISTINCT r.repo AS repo FROM findings f
     INNER JOIN reviews r ON r.id = f.review_id
     WHERE r.kind = 'pr'
       AND r.repo IN (SELECT full_name FROM repos WHERE active = 1)
     ORDER BY r.repo`,
    )
    .all()
    .map((row) => row.repo);
}
