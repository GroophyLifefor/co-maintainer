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
