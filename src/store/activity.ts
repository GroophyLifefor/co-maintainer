/** The rows of the Activity list. A review is one row: the job that ran it
 * and the review row it wrote, joined. Every other job is one row on its
 * own. A review row whose job row is gone still shows, as its own row. */
import { getAppDb } from "./app_db.ts";
import type { JobRow, ReviewRow } from "./rows.ts";

/** The state a row is filtered and shown by. A queued job counts as
 * running. A done job whose review failed counts as failed. */
export type ActivityState =
  | "running"
  | "done"
  | "failed"
  | "canceled"
  | "skipped";

export const ACTIVITY_STATES: ActivityState[] = [
  "running",
  "done",
  "failed",
  "canceled",
  "skipped",
];

export type ActivityStoreFilter = {
  state?: ActivityState;
  /** Job types to keep. Empty or unset keeps every type. */
  types?: string[];
  repo?: string;
  pr?: number;
  /** Inclusive start, an ISO time. */
  sinceIso?: string;
  /** Exclusive end, an ISO time. */
  untilIso?: string;
  /** Words to find in the repository, the pull request title, the error or
   * the pull request number. */
  q?: string;
  /** With `state: "failed"`, also the failures someone dismissed or a later
   * review resolved. Without it they are left out of that list. */
  withSettled?: boolean;
};

export type ActivityRow = {
  key: string;
  at: string;
  state: ActivityState;
  job: JobRow | undefined;
  review: ReviewRow | undefined;
  title: string | undefined;
};

/** One row per job, and one per review whose job row is gone, with the
 * columns every filter reads. */
const ROWS = `
  SELECT 'job:' || j.id AS key, j.id AS job_id, r.id AS review_id,
    j.created_at AS at, j.repo AS repo, j.pr_number AS pr_number,
    j.type AS type, j.error AS error,
    CASE
      WHEN j.status IN ('queued', 'running') THEN 'running'
      WHEN j.status = 'failed' OR r.status = 'failed' THEN 'failed'
      WHEN j.status = 'canceled' THEN 'canceled'
      WHEN j.type = 'skip' THEN 'skipped'
      ELSE 'done'
    END AS state,
    COALESCE(j.seen_at, r.seen_at) AS seen_at,
    COALESCE(j.resolved_by, r.resolved_by) AS resolved_by
  FROM jobs j
  LEFT JOIN reviews r ON r.id = (
    SELECT id FROM reviews WHERE job_id = j.id ORDER BY created_at DESC LIMIT 1)
  UNION ALL
  SELECT 'review:' || r.id, NULL, r.id, r.created_at, r.repo, r.pr_number,
    CASE r.kind WHEN 'push' THEN 'push_review'
      WHEN 'remote' THEN 'remote_review' ELSE 'review' END,
    NULL,
    CASE
      WHEN r.status = 'failed' THEN 'failed'
      WHEN r.status IN ('canceled', 'aborted') THEN 'canceled'
      ELSE 'done'
    END,
    r.seen_at, r.resolved_by
  FROM reviews r
  WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE id = r.job_id)`;

function whereOf(filter: ActivityStoreFilter): {
  sql: string;
  params: (string | number)[];
} {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.state) {
    clauses.push("a.state = ?");
    params.push(filter.state);
    if (filter.state === "failed" && !filter.withSettled) {
      clauses.push("a.seen_at IS NULL AND a.resolved_by IS NULL");
    }
  }
  if (filter.types?.length) {
    clauses.push(`a.type IN (${filter.types.map(() => "?").join(", ")})`);
    params.push(...filter.types);
  }
  if (filter.repo) {
    clauses.push("a.repo = ?");
    params.push(filter.repo);
  }
  if (filter.pr !== undefined) {
    clauses.push("a.pr_number = ?");
    params.push(filter.pr);
  }
  if (filter.sinceIso) {
    clauses.push("a.at >= ?");
    params.push(filter.sinceIso);
  }
  if (filter.untilIso) {
    clauses.push("a.at < ?");
    params.push(filter.untilIso);
  }
  if (filter.q) {
    const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const number = Number(filter.q.replace(/^#/, ""));
    clauses.push(
      `(a.repo LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\'
        OR a.error LIKE ? ESCAPE '\\' OR a.pr_number = ?)`,
    );
    params.push(like, like, like, Number.isSafeInteger(number) ? number : -1);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

const FROM = `FROM (${ROWS}) a
  LEFT JOIN pull_titles t ON t.repo = a.repo AND t.pr_number = a.pr_number`;

/** One page of rows, newest first, and how many match in all. */
export function listActivity(
  filter: ActivityStoreFilter,
  limit: number,
  offset: number,
): { items: ActivityRow[]; total: number } {
  const db = getAppDb();
  const where = whereOf(filter);
  const total = Number(
    db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n ${FROM} ${where.sql}`)
      .get(...where.params)?.n ?? 0,
  );
  const keys = db
    .prepare<{
      key: string;
      job_id: string | null;
      review_id: string | null;
      at: string;
      state: ActivityState;
      title: string | null;
    }>(
      `SELECT a.key, a.job_id, a.review_id, a.at, a.state, t.title ${FROM}
       ${where.sql} ORDER BY a.at DESC, a.key DESC LIMIT ? OFFSET ?`,
    )
    .all(...where.params, limit, offset);
  const getJob = db.prepare<JobRow>(`SELECT * FROM jobs WHERE id = ?`);
  const getReview = db.prepare<ReviewRow>(`SELECT * FROM reviews WHERE id = ?`);
  return {
    total,
    items: keys.map((row) => ({
      key: row.key,
      at: row.at,
      state: row.state,
      job: row.job_id ? getJob.get(row.job_id) : undefined,
      review: row.review_id ? getReview.get(row.review_id) : undefined,
      title: row.title ?? undefined,
    })),
  };
}

/** How many failures of this filter are dismissed or resolved, for the
 * toggle that shows them on the failed list. */
export function settledFailureCount(filter: ActivityStoreFilter): number {
  const where = whereOf({ ...filter, state: "failed", withSettled: true });
  return Number(
    getAppDb()
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n ${FROM} ${where.sql}
         ${where.sql ? "AND" : "WHERE"} (a.seen_at IS NOT NULL OR a.resolved_by IS NOT NULL)`,
      )
      .get(...where.params)?.n ?? 0,
  );
}

/** A short text that changes whenever the Activity page would change: a job
 * queued, started, finished or dismissed, a review written, a delivery
 * recorded, or a log line of a running job. The page polls it and fetches
 * the list only when it moved. */
export function activityStamp(): string {
  const row = getAppDb()
    .prepare<Record<string, string | number | null>>(
      `SELECT
        (SELECT COUNT(*) FROM jobs) AS jobs,
        (SELECT MAX(MAX(created_at), MAX(COALESCE(started_at, '')),
          MAX(COALESCE(finished_at, '')), MAX(COALESCE(seen_at, ''))) FROM jobs) AS job_at,
        (SELECT COUNT(*) FROM reviews) AS reviews,
        (SELECT MAX(COALESCE(seen_at, '')) FROM reviews) AS review_seen,
        (SELECT COUNT(*) FROM reviews WHERE resolved_by IS NOT NULL) AS resolved,
        (SELECT MAX(received_at) FROM deliveries) AS delivery_at,
        (SELECT COUNT(*) FROM job_logs WHERE job_id IN
          (SELECT id FROM jobs WHERE status IN ('queued', 'running'))) AS live_lines`,
    )
    .get();
  return [
    row?.jobs,
    row?.job_at,
    row?.reviews,
    row?.review_seen,
    row?.resolved,
    row?.delivery_at,
    row?.live_lines,
  ]
    .map((value) => String(value ?? ""))
    .join("|");
}
