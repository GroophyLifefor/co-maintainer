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
  /** Only findings on pull requests this GitHub login opened. */
  author?: string;
  /** Where the findings came from. Unset lists every review's findings:
   * pull request, push, remote and CLI reviews. `extension` lists the
   * findings extensions added instead. */
  source?: FindingSource;
};

export const FINDING_SOURCES = [
  "pr",
  "push",
  "remote",
  "cli",
  "extension",
] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

/** The review kinds behind each source. */
const KINDS: Record<Exclude<FindingSource, "extension">, string[]> = {
  pr: ["pr"],
  push: ["push"],
  remote: ["remote"],
  cli: ["local", "cli_pr"],
};

/** Extension findings in the shape of a review finding, so one list shows
 * either. */
const EXTENSION_ROWS = `(SELECT e.id AS id, e.review_id AS review_id,
    e.severity AS severity, e.path AS path, e.line_from AS line_from,
    e.line_to AS line_to, e.title AS title, e.body AS body_md,
    NULL AS posted_comment_id, NULL AS thread_comment_id,
    NULL AS first_seen_review_id, NULL AS anchor_text, e.state AS state,
    NULL AS carried_from_finding_id, NULL AS close_reason,
    '[]' AS references_json
  FROM extension_findings e)`;

function fromOf(filter: FindingFilter): string {
  const findings = filter.source === "extension" ? EXTENSION_ROWS : "findings";
  return `${findings} f INNER JOIN reviews r ON r.id = f.review_id`;
}

export type FindingListRow = FindingRow & {
  repo: string;
  /** Null for a push, remote or local review. */
  pr_number: number | null;
  review_kind: string;
  job_id: string;
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
    "r.repo IN (SELECT full_name FROM repos WHERE active = 1)",
    filter.source === "extension"
      ? // A tracked extension finding is stored again each round: only the
        // newest copy is listed.
        `NOT EXISTS (SELECT 1 FROM extension_findings n
          INNER JOIN reviews nr ON nr.id = n.review_id
          WHERE n.id = f.id AND nr.repo = r.repo AND nr.created_at > r.created_at)`
      : "NOT EXISTS (SELECT 1 FROM findings c WHERE c.carried_from_finding_id = f.id)",
  ];
  const params: (string | number)[] = [];
  if (filter.source && filter.source !== "extension") {
    const kinds = KINDS[filter.source];
    where.push(`r.kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }
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
  if (filter.author) {
    where.push(
      `EXISTS (SELECT 1 FROM pull_titles a WHERE a.repo = r.repo
        AND a.pr_number = r.pr_number AND a.author = ?)`,
    );
    params.push(filter.author);
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
        `SELECT COUNT(*) AS n FROM ${fromOf(filter)}
       WHERE ${sql}`,
      )
      .get(...params)?.n ?? 0,
  );
  const items = getAppDb()
    .prepare<FindingListRow>(
      `SELECT f.*, r.repo AS repo, r.pr_number AS pr_number, r.round AS round,
        r.head_sha AS head_sha, r.created_at AS reviewed_at, t.title AS pr_title,
        r.kind AS review_kind, r.job_id AS job_id
     FROM ${fromOf(filter)}
     LEFT JOIN pull_titles t ON t.repo = r.repo AND t.pr_number = r.pr_number
     WHERE ${sql}
     ORDER BY r.created_at DESC, f.severity, f.id
     LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  return { items, total };
}

export type SeverityStats = {
  severity: string;
  findings: number;
  /** Raised again after the author saw it: still open from an earlier round,
   * or first seen in one. */
  repeats: number;
  posted: number;
};

/** How many findings the list would show, by severity, so a stat card or a
 * table row opens a list with exactly its number in it. */
export function findingStatsBySeverity(filter: FindingFilter): SeverityStats[] {
  const { sql, params } = whereOf(filter);
  return getAppDb()
    .prepare<SeverityStats>(
      `SELECT f.severity AS severity,
        COUNT(*) AS findings,
        COALESCE(SUM(f.state = 'open' OR f.first_seen_review_id IS NOT NULL), 0) AS repeats,
        COALESCE(SUM(f.posted_comment_id IS NOT NULL AND f.posted_comment_id != ''), 0) AS posted
     FROM ${fromOf(filter)}
     WHERE ${sql}
     GROUP BY f.severity
     ORDER BY f.severity`,
    )
    .all(...params)
    .map((row) => ({
      severity: String(row.severity),
      findings: Number(row.findings),
      repeats: Number(row.repeats),
      posted: Number(row.posted),
    }));
}

/** The repositories that have at least one listed finding, for the
 * repository filter on the all-repositories list. */
export function repositoriesWithFindings(): string[] {
  return getAppDb()
    .prepare<{ repo: string }>(
      `SELECT DISTINCT r.repo AS repo FROM findings f
     INNER JOIN reviews r ON r.id = f.review_id
     WHERE r.repo IN (SELECT full_name FROM repos WHERE active = 1)
     ORDER BY r.repo`,
    )
    .all()
    .map((row) => row.repo);
}

/** The listed findings per repository, counted the way the list counts, so
 * the Usage table and the list agree. */
export function findingCountsByRepo(
  filter: FindingFilter,
): Map<string, number> {
  const { sql, params } = whereOf(filter);
  const rows = getAppDb()
    .prepare<{ repo: string; n: number }>(
      `SELECT r.repo AS repo, COUNT(*) AS n FROM ${fromOf(filter)}
     WHERE ${sql} GROUP BY r.repo`,
    )
    .all(...params);
  return new Map(rows.map((row) => [row.repo, Number(row.n)]));
}
