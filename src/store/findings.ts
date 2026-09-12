import { getAppDb } from "./app_db.ts";
import type { FindingRow } from "./rows.ts";

export function insertFinding(row: {
  id: string;
  reviewId: string;
  severity: string;
  path?: string;
  lineFrom?: number;
  lineTo?: number;
  title: string;
  bodyMd: string;
  firstSeenReviewId?: string;
  threadCommentId?: string;
}): void {
  getAppDb().prepare(
    `INSERT INTO findings
       (id, review_id, severity, path, line_from, line_to, title, body_md,
        first_seen_review_id, thread_comment_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.reviewId,
    row.severity,
    row.path ?? null,
    row.lineFrom ?? null,
    row.lineTo ?? null,
    row.title,
    row.bodyMd,
    row.firstSeenReviewId ?? null,
    row.threadCommentId ?? null,
  );
}

export function setFindingPosted(
  id: string,
  postedCommentId: string,
  threadCommentId?: string,
): void {
  getAppDb().prepare(
    `UPDATE findings SET posted_comment_id = ?, thread_comment_id = COALESCE(?, thread_comment_id) WHERE id = ?`,
  ).run(postedCommentId, threadCommentId ?? null, id);
}

export function listFindingsForReview(reviewId: string): FindingRow[] {
  return getAppDb().prepare<FindingRow>(
    `SELECT * FROM findings WHERE review_id = ? ORDER BY severity, id`,
  ).all(reviewId);
}

export function listFindingsForPr(
  repo: string,
  prNumber: number,
): FindingRow[] {
  return getAppDb().prepare<FindingRow>(
    `SELECT f.* FROM findings f
     INNER JOIN reviews r ON r.id = f.review_id
     WHERE r.repo = ? AND r.pr_number = ?
     ORDER BY r.round, f.id`,
  ).all(repo, prNumber);
}

export function findFindingByPostedComment(
  repo: string,
  prNumber: number,
  commentId: string,
): FindingRow | undefined {
  return getAppDb().prepare<FindingRow>(
    `SELECT f.* FROM findings f
     INNER JOIN reviews r ON r.id = f.review_id
     WHERE r.repo = ? AND r.pr_number = ? AND f.posted_comment_id = ?
     ORDER BY r.created_at DESC LIMIT 1`,
  ).get(repo, prNumber, commentId);
}

export type SeverityStats = {
  severity: string;
  findings: number;
  repeats: number;
  posted: number;
};

/** A repeat is a finding the previous round already raised, so the repeat
 * column reads as "raised again after the author saw it". */
export function findingStatsBySeverity(sinceIso: string): SeverityStats[] {
  return getAppDb().prepare<SeverityStats>(
    `SELECT f.severity AS severity,
        COUNT(*) AS findings,
        COALESCE(SUM(f.first_seen_review_id IS NOT NULL), 0) AS repeats,
        COALESCE(SUM(f.posted_comment_id IS NOT NULL), 0) AS posted
     FROM findings f
     INNER JOIN reviews r ON r.id = f.review_id
     WHERE r.created_at >= ?
     GROUP BY f.severity
     ORDER BY f.severity`,
  ).all(sinceIso).map((row) => ({
    severity: String(row.severity),
    findings: Number(row.findings),
    repeats: Number(row.repeats),
    posted: Number(row.posted),
  }));
}
