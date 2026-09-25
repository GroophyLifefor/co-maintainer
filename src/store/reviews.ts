import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import type { ReviewRow } from "./rows.ts";

export function insertRemoteReview(row: {
  id: string;
  subjectId: string;
  repo: string;
  branch: string;
  tokenId: string;
  tokenName: string;
  jobId: string;
  scope: string;
  model: string;
}): void {
  getAppDb()
    .prepare(
      `INSERT INTO reviews
       (id, kind, subject_id, repo, pr_number, branch, token_id, token_name,
        job_id, head_sha, base_sha, scope, model, status, created_at, round,
        cost_status, cost_note, billed_to)
     VALUES (?, 'remote', ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, 'queued', ?, 1,
        'unknown', 'not_recorded', 'server')`,
    )
    .run(
      row.id,
      row.subjectId,
      row.repo,
      row.branch,
      row.tokenId,
      row.tokenName,
      row.jobId,
      row.scope,
      row.model,
      nowIso(),
    );
}

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
  subjectId?: string;
  guideBuiltAt?: string | null;
}): void {
  getAppDb()
    .prepare(
      `INSERT INTO reviews
       (id, kind, subject_id, repo, pr_number, job_id, head_sha, base_sha, scope, model,
        status, created_at, round, "trigger", guide_built_at,
        cost_status, cost_note, billed_to)
     VALUES (?, 'pr', ?, ?, ?, ?, ?, ?, ?, ?, 'drafting', ?, ?, ?, ?,
        'unknown', 'not_recorded', 'server')`,
    )
    .run(
      row.id,
      row.subjectId ?? null,
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
      row.guideBuiltAt ?? null,
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
      | "cost_status"
      | "cost_note"
      | "billed_to"
      | "duration_ms"
      | "check_run_id"
      | "posted_fallback"
      | "open_count"
      | "closed_count"
      | "subject_id"
      | "guide_built_at"
    >
  > = {},
): void {
  getAppDb()
    .prepare(
      `UPDATE reviews SET status = ?,
       posted_review_id = COALESCE(?, posted_review_id),
       findings_count = COALESCE(?, findings_count),
       open_count = COALESCE(?, open_count),
       closed_count = COALESCE(?, closed_count),
       tokens_in = COALESCE(?, tokens_in),
       tokens_out = COALESCE(?, tokens_out),
       cost = COALESCE(?, cost),
       cost_status = COALESCE(?, cost_status),
       cost_note = CASE WHEN ? IS NULL THEN cost_note ELSE ? END,
       billed_to = COALESCE(?, billed_to),
       duration_ms = COALESCE(?, duration_ms),
       check_run_id = COALESCE(?, check_run_id),
       posted_fallback = COALESCE(?, posted_fallback),
       subject_id = COALESCE(?, subject_id),
       guide_built_at = COALESCE(?, guide_built_at)
     WHERE id = ?`,
    )
    .run(
      status,
      patch.posted_review_id ?? null,
      patch.findings_count ?? null,
      patch.open_count ?? null,
      patch.closed_count ?? null,
      patch.tokens_in ?? null,
      patch.tokens_out ?? null,
      patch.cost ?? null,
      patch.cost_status ?? null,
      patch.cost_status ?? null,
      patch.cost_note ?? null,
      patch.billed_to ?? null,
      patch.duration_ms ?? null,
      patch.check_run_id ?? null,
      patch.posted_fallback ?? null,
      patch.subject_id ?? null,
      patch.guide_built_at ?? null,
      id,
    );
}

export function setReviewScope(
  id: string,
  scope: string,
  baseSha: string,
): void {
  getAppDb()
    .prepare(`UPDATE reviews SET scope = ?, base_sha = ? WHERE id = ?`)
    .run(scope, baseSha, id);
}

export function getReview(id: string): ReviewRow | undefined {
  return getAppDb()
    .prepare<ReviewRow>(`SELECT * FROM reviews WHERE id = ?`)
    .get(id);
}

export function getReviewByJobId(jobId: string): ReviewRow | undefined {
  return getAppDb()
    .prepare<ReviewRow>(
      `SELECT * FROM reviews WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(jobId);
}

/** Newest round first. The PR detail page reads this directly. */
export function listReviewsForPr(repo: string, prNumber: number): ReviewRow[] {
  return getAppDb()
    .prepare<ReviewRow>(
      `SELECT * FROM reviews WHERE repo = ? AND pr_number = ? ORDER BY round DESC, created_at DESC`,
    )
    .all(repo, prNumber);
}

export function latestPostedReview(
  repo: string,
  prNumber: number,
): ReviewRow | undefined {
  return getAppDb()
    .prepare<ReviewRow>(
      `SELECT * FROM reviews
     WHERE repo = ? AND pr_number = ? AND status = 'posted'
     ORDER BY round DESC, created_at DESC LIMIT 1`,
    )
    .get(repo, prNumber);
}

/** `cost` adds up only the costs that are known and billed to the server.
 * A review with an unknown cost is counted in `unknownCount` instead of
 * being added as zero. BYOK is kept apart, never inside `cost`. */
export type CostTotals = {
  cost: number;
  unknownCount: number;
  byokUsd: number;
  byokUnknownCount: number;
};

const COST_STATUS = `COALESCE(cost_status, CASE WHEN cost IS NULL THEN 'unknown' ELSE 'known' END)`;
const BILLED = `COALESCE(billed_to, 'server')`;
const bucket = (status: string, billed: string, value: string) =>
  `COALESCE(SUM(CASE WHEN ${COST_STATUS} = '${status}' AND ${BILLED} = '${billed}' THEN ${value} END), 0)`;

/** The four figures of `CostTotals`, ready to sit in any SELECT list. */
const COST_COLUMNS = `${bucket("known", "server", "cost")} AS cost,
      ${bucket("unknown", "server", "1")} AS unknownCount,
      ${bucket("known", "byok", "cost")} AS byokUsd,
      ${bucket("unknown", "byok", "1")} AS byokUnknownCount`;

function asCostTotals(row: Partial<CostTotals> | undefined): CostTotals {
  return {
    cost: Number(row?.cost ?? 0),
    unknownCount: Number(row?.unknownCount ?? 0),
    byokUsd: Number(row?.byokUsd ?? 0),
    byokUnknownCount: Number(row?.byokUnknownCount ?? 0),
  };
}

export type ReviewStats = CostTotals & {
  reviews: number;
  pullRequests: number;
  findings: number;
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
      ${COST_COLUMNS},
      COALESCE(SUM(tokens_in), 0) AS tokensIn,
      COALESCE(SUM(tokens_out), 0) AS tokensOut,
      COALESCE(SUM(status = 'failed'), 0) AS failed,
      COALESCE(AVG(duration_ms), 0) AS avgDurationMs`;

function asStats(row: Partial<ReviewStats> | undefined): ReviewStats {
  return {
    reviews: Number(row?.reviews ?? 0),
    pullRequests: Number(row?.pullRequests ?? 0),
    findings: Number(row?.findings ?? 0),
    ...asCostTotals(row),
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
  const where = ["created_at >= ?", "kind = 'pr'"];
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
    getAppDb()
      .prepare<ReviewStats>(
        `SELECT ${STATS_COLUMNS} FROM reviews WHERE ${where.join(" AND ")}`,
      )
      .get(...params),
  );
}

export function reviewStatsByRepo(
  sinceIso: string,
): (ReviewStats & { repo: string })[] {
  return getAppDb()
    .prepare<ReviewStats & { repo: string }>(
      `SELECT repo, ${STATS_COLUMNS}
     FROM reviews WHERE created_at >= ?
     GROUP BY repo
     ORDER BY cost DESC`,
    )
    .all(sinceIso)
    .map((row) => ({ ...asStats(row), repo: row.repo }));
}

export type DayStats = CostTotals & {
  day: string;
  reviews: number;
  findings: number;
};

export function reviewStatsByDay(sinceIso: string): DayStats[] {
  return getAppDb()
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
        COUNT(*) AS reviews,
        COALESCE(SUM(findings_count), 0) AS findings,
        ${COST_COLUMNS}
     FROM reviews WHERE created_at >= ?
     GROUP BY day
     ORDER BY day`,
    )
    .all(sinceIso)
    .map((row) => {
      const value = row as DayStats;
      return {
        day: value.day,
        reviews: Number(value.reviews),
        findings: Number(value.findings),
        ...asCostTotals(value),
      };
    });
}

export function reviewStatsByModel(
  sinceIso: string,
): (ReviewStats & { model: string })[] {
  return getAppDb()
    .prepare<ReviewStats & { model: string }>(
      `SELECT model, ${STATS_COLUMNS}
     FROM reviews WHERE created_at >= ?
     GROUP BY model
     ORDER BY cost DESC`,
    )
    .all(sinceIso)
    .map((row) => ({ ...asStats(row), model: row.model }));
}

export function listRecentReviews(limit: number, offset = 0): ReviewRow[] {
  return getAppDb()
    .prepare<ReviewRow>(
      `SELECT * FROM reviews ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);
}

export function countReviews(): number {
  return Number(
    getAppDb().prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM reviews`).get()
      ?.n ?? 0,
  );
}

export type PullSummary = CostTotals & {
  pr_number: number;
  last_reviewed: string;
  findings: number;
  review_count: number;
};

export function listPullSummaries(
  repo: string,
  limit: number,
  offset: number,
): { items: PullSummary[]; total: number } {
  const total = Number(
    getAppDb()
      .prepare<{ n: number }>(
        `SELECT COUNT(DISTINCT pr_number) AS n FROM reviews WHERE repo = ?`,
      )
      .get(repo)?.n ?? 0,
  );
  const items = getAppDb()
    .prepare<PullSummary>(
      `SELECT pr_number,
        MAX(created_at) AS last_reviewed,
        COALESCE(SUM(findings_count), 0) AS findings,
        ${COST_COLUMNS},
        COUNT(*) AS review_count
     FROM reviews WHERE repo = ?
     GROUP BY pr_number
     ORDER BY last_reviewed DESC
     LIMIT ? OFFSET ?`,
    )
    .all(repo, limit, offset);
  return {
    items: items.map((item) => ({ ...item, ...asCostTotals(item) })),
    total,
  };
}

export function listRemoteReviewsForRepo(
  repo: string,
  limit: number,
  offset = 0,
  sinceIso?: string,
): ReviewRow[] {
  if (sinceIso) {
    return getAppDb()
      .prepare<ReviewRow>(
        `SELECT * FROM reviews
       WHERE repo = ? AND kind = 'remote' AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      )
      .all(repo, sinceIso, limit, offset);
  }
  return getAppDb()
    .prepare<ReviewRow>(
      `SELECT * FROM reviews
     WHERE repo = ? AND kind = 'remote'
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    )
    .all(repo, limit, offset);
}

export function remoteTokenUsageSince(
  tokenId: string,
  sinceIso: string,
): CostTotals & { reviews: number } {
  const row = getAppDb()
    .prepare<CostTotals & { reviews: number }>(
      `SELECT COUNT(*) AS reviews, ${COST_COLUMNS}
     FROM reviews
     WHERE token_id = ? AND kind = 'remote' AND created_at >= ?`,
    )
    .get(tokenId, sinceIso);
  return {
    reviews: Number(row?.reviews ?? 0),
    ...asCostTotals(row),
  };
}

export function reviewStatsByRemoteToken(sinceIso: string): (CostTotals & {
  tokenId: string;
  tokenName: string;
  reviews: number;
  findings: number;
})[] {
  return getAppDb()
    .prepare<
      CostTotals & {
        token_id: string;
        token_name: string;
        reviews: number;
        findings: number;
      }
    >(
      `SELECT token_id, token_name,
            COUNT(*) AS reviews,
            ${COST_COLUMNS},
            COALESCE(SUM(findings_count), 0) AS findings
     FROM reviews
     WHERE kind = 'remote' AND created_at >= ? AND token_id IS NOT NULL
     GROUP BY token_id, token_name
     ORDER BY cost DESC`,
    )
    .all(sinceIso)
    .map((row) => ({
      tokenId: row.token_id,
      tokenName: row.token_name,
      reviews: Number(row.reviews),
      ...asCostTotals(row),
      findings: Number(row.findings),
    }));
}

export function listLatestReviewsForRepo(
  repo: string,
  limit: number,
): ReviewRow[] {
  return getAppDb()
    .prepare<ReviewRow>(
      `SELECT r.* FROM reviews r
     INNER JOIN (
       SELECT pr_number, MAX(created_at) AS t
       FROM reviews WHERE repo = ?
       GROUP BY pr_number
     ) latest
       ON r.repo = ? AND r.pr_number = latest.pr_number AND r.created_at = latest.t
     ORDER BY r.created_at DESC
     LIMIT ?`,
    )
    .all(repo, repo, limit);
}
