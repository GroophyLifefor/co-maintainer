import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import type { ReviewRow } from "./rows.ts";

export function insertReview(row: {
  id: string;
  repo: string;
  prNumber: number;
  jobId: string;
  headSha: string;
  baseSha: string;
  scope: string;
  model: string;
  trigger?: string;
  round?: number;
}): void {
  getAppDb().prepare(
    `INSERT INTO reviews
       (id, repo, pr_number, job_id, head_sha, base_sha, scope, model,
        status, created_at, round, "trigger")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'drafting', ?, ?, ?)`,
  ).run(
    row.id,
    row.repo,
    row.prNumber,
    row.jobId,
    row.headSha,
    row.baseSha,
    row.scope,
    row.model,
    nowIso(),
    row.round ?? 1,
    row.trigger ?? null,
  );
}

/** Written immediately before and after the `POST .../reviews` call, with
 * nothing else run between either write and the call. */
export function setReviewStatus(
  id: string,
  status: ReviewRow["status"],
  patch: Partial<
    Pick<
      ReviewRow,
      | "posted_review_id"
      | "findings_count"
      | "tokens_in"
      | "tokens_out"
      | "cost"
      | "duration_ms"
      | "check_run_id"
      | "posted_fallback"
    >
  > = {},
): void {
  getAppDb().prepare(
    `UPDATE reviews SET status = ?,
       posted_review_id = COALESCE(?, posted_review_id),
       findings_count = COALESCE(?, findings_count),
       tokens_in = COALESCE(?, tokens_in),
       tokens_out = COALESCE(?, tokens_out),
       cost = COALESCE(?, cost),
       duration_ms = COALESCE(?, duration_ms),
       check_run_id = COALESCE(?, check_run_id),
       posted_fallback = COALESCE(?, posted_fallback)
     WHERE id = ?`,
  ).run(
    status,
    patch.posted_review_id ?? null,
    patch.findings_count ?? null,
    patch.tokens_in ?? null,
    patch.tokens_out ?? null,
    patch.cost ?? null,
    patch.duration_ms ?? null,
    patch.check_run_id ?? null,
    patch.posted_fallback ?? null,
    id,
  );
}

export function setReviewScope(
  id: string,
  scope: string,
  baseSha: string,
): void {
  getAppDb().prepare(`UPDATE reviews SET scope = ?, base_sha = ? WHERE id = ?`)
    .run(scope, baseSha, id);
}

export function getReview(id: string): ReviewRow | undefined {
  return getAppDb().prepare<ReviewRow>(`SELECT * FROM reviews WHERE id = ?`)
    .get(id);
}

export function getReviewByJobId(jobId: string): ReviewRow | undefined {
  return getAppDb().prepare<ReviewRow>(
    `SELECT * FROM reviews WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(jobId);
}

/** Newest round first. The PR detail page reads this directly. */
export function listReviewsForPr(repo: string, prNumber: number): ReviewRow[] {
  return getAppDb().prepare<ReviewRow>(
    `SELECT * FROM reviews WHERE repo = ? AND pr_number = ? ORDER BY round DESC, created_at DESC`,
  ).all(repo, prNumber);
}

export function latestPostedReview(
  repo: string,
  prNumber: number,
): ReviewRow | undefined {
  return getAppDb().prepare<ReviewRow>(
    `SELECT * FROM reviews
     WHERE repo = ? AND pr_number = ? AND status = 'posted'
     ORDER BY round DESC, created_at DESC LIMIT 1`,
  ).get(repo, prNumber);
}

export type ReviewStats = {
  reviews: number;
  pullRequests: number;
  findings: number;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  failed: number;
  avgDurationMs: number;
};

/** Every aggregate the dashboard reads comes from this one column list, so a
 * new figure lands on the totals, the per repo table and the trend window at
 * the same time. */
const STATS_COLUMNS = `COUNT(*) AS reviews,
      COUNT(DISTINCT pr_number) AS pullRequests,
      COALESCE(SUM(findings_count), 0) AS findings,
      COALESCE(SUM(cost), 0) AS cost,
      COALESCE(SUM(tokens_in), 0) AS tokensIn,
      COALESCE(SUM(tokens_out), 0) AS tokensOut,
      COALESCE(SUM(status = 'failed'), 0) AS failed,
      COALESCE(AVG(duration_ms), 0) AS avgDurationMs`;

function asStats(row: Partial<ReviewStats> | undefined): ReviewStats {
  return {
    reviews: Number(row?.reviews ?? 0),
    pullRequests: Number(row?.pullRequests ?? 0),
    findings: Number(row?.findings ?? 0),
    cost: Number(row?.cost ?? 0),
    tokensIn: Number(row?.tokensIn ?? 0),
    tokensOut: Number(row?.tokensOut ?? 0),
    failed: Number(row?.failed ?? 0),
    avgDurationMs: Number(row?.avgDurationMs ?? 0),
  };
}

/** `untilIso` is exclusive, which is what lets the trend row ask for the
 * window before the one on screen without double counting its edge. */
export function reviewStats(
  sinceIso: string,
  repo?: string,
  untilIso?: string,
): ReviewStats {
  const where = ["created_at >= ?"];
  const params: (string | number)[] = [sinceIso];
  if (untilIso) {
    where.push("created_at < ?");
    params.push(untilIso);
  }
  if (repo) {
    where.push("repo = ?");
    params.push(repo);
  }
  return asStats(
    getAppDb().prepare<ReviewStats>(
      `SELECT ${STATS_COLUMNS} FROM reviews WHERE ${where.join(" AND ")}`,
    ).get(...params),
  );
}

export function reviewStatsByRepo(
  sinceIso: string,
): (ReviewStats & { repo: string })[] {
  return getAppDb().prepare<ReviewStats & { repo: string }>(
    `SELECT repo, ${STATS_COLUMNS}
     FROM reviews WHERE created_at >= ?
     GROUP BY repo
     ORDER BY cost DESC`,
  ).all(sinceIso).map((row) => ({ ...asStats(row), repo: row.repo }));
}

export function reviewStatsByDay(
  sinceIso: string,
): { day: string; reviews: number; findings: number; cost: number }[] {
  return getAppDb().prepare(
    `SELECT substr(created_at, 1, 10) AS day,
        COUNT(*) AS reviews,
        COALESCE(SUM(findings_count), 0) AS findings,
        COALESCE(SUM(cost), 0) AS cost
     FROM reviews WHERE created_at >= ?
     GROUP BY day
     ORDER BY day`,
  ).all(sinceIso) as {
    day: string;
    reviews: number;
    findings: number;
    cost: number;
  }[];
}

export function reviewStatsByModel(
  sinceIso: string,
): (ReviewStats & { model: string })[] {
  return getAppDb().prepare<ReviewStats & { model: string }>(
    `SELECT model, ${STATS_COLUMNS}
     FROM reviews WHERE created_at >= ?
     GROUP BY model
     ORDER BY cost DESC`,
  ).all(sinceIso).map((row) => ({ ...asStats(row), model: row.model }));
}

export function listRecentReviews(limit: number, offset = 0): ReviewRow[] {
  return getAppDb().prepare<ReviewRow>(
    `SELECT * FROM reviews ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(limit, offset);
}

export function countReviews(): number {
  return Number(
    getAppDb().prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM reviews`)
      .get()?.n ?? 0,
  );
}

export type PullSummary = {
  pr_number: number;
  last_reviewed: string;
  findings: number;
  cost: number;
  review_count: number;
};

export function listPullSummaries(
  repo: string,
  limit: number,
  offset: number,
): { items: PullSummary[]; total: number } {
  const total = Number(
    getAppDb().prepare<{ n: number }>(
      `SELECT COUNT(DISTINCT pr_number) AS n FROM reviews WHERE repo = ?`,
    ).get(repo)?.n ?? 0,
  );
  const items = getAppDb().prepare<PullSummary>(
    `SELECT pr_number,
        MAX(created_at) AS last_reviewed,
        COALESCE(SUM(findings_count), 0) AS findings,
        COALESCE(SUM(cost), 0) AS cost,
        COUNT(*) AS review_count
     FROM reviews WHERE repo = ?
     GROUP BY pr_number
     ORDER BY last_reviewed DESC
     LIMIT ? OFFSET ?`,
  ).all(repo, limit, offset);
  return { items, total };
}

export function listLatestReviewsForRepo(
  repo: string,
  limit: number,
): ReviewRow[] {
  return getAppDb().prepare<ReviewRow>(
    `SELECT r.* FROM reviews r
     INNER JOIN (
       SELECT pr_number, MAX(created_at) AS t
       FROM reviews WHERE repo = ?
       GROUP BY pr_number
     ) latest
       ON r.repo = ? AND r.pr_number = latest.pr_number AND r.created_at = latest.t
     ORDER BY r.created_at DESC
     LIMIT ?`,
  ).all(repo, repo, limit);
}
