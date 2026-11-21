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
  anchorText?: string | null;
  state?: string;
  carriedFromFindingId?: string | null;
  closeReason?: string | null;
  /** `ResolvedReference[]` as JSON. Missing stores `[]`. */
  referencesJson?: string;
}): void {
  getAppDb()
    .prepare(
      `INSERT INTO findings
       (id, review_id, severity, path, line_from, line_to, title, body_md,
        first_seen_review_id, thread_comment_id, anchor_text, state,
        carried_from_finding_id, close_reason, references_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
      row.anchorText ?? null,
      row.state ?? "new",
      row.carriedFromFindingId ?? null,
      row.closeReason ?? null,
      row.referencesJson ?? "[]",
    );
}

export function listCarryableFindingsForReview(reviewId: string): FindingRow[] {
  return getAppDb()
    .prepare<FindingRow>(
      `SELECT * FROM findings
     WHERE review_id = ? AND state IN ('new', 'open')
     ORDER BY severity, id`,
    )
    .all(reviewId);
}

/** A finding the bot agreed was wrong, in a reply on its thread. It is
 * closed at once, so the next round does not carry it as still open. */
export function withdrawFinding(id: string): void {
  // The copies later rounds carried from it close too: the newest copy is the
  // one the Findings list shows and the next review's event counts.
  getAppDb()
    .prepare(
      `WITH RECURSIVE chain(id) AS (
         SELECT ?
         UNION
         SELECT f.id FROM findings f INNER JOIN chain c ON f.carried_from_finding_id = c.id
       )
       UPDATE findings SET state = 'closed', close_reason = 'withdrawn'
       WHERE id IN (SELECT id FROM chain)`,
    )
    .run(id);
}

/** Every finding of a pull request the bot withdrew or a maintainer
 * dismissed, so a later round does not raise it again while its lines are
 * unchanged. */
export function listWithdrawnFindingsForPr(
  repo: string,
  prNumber: number,
): FindingRow[] {
  return listFindingsForPr(repo, prNumber).filter(
    (row) =>
      row.close_reason === "withdrawn" || row.close_reason === "dismissed",
  );
}

/** A maintainer closes a finding (accepted risk, will not fix) or opens it
 * again. Like a withdrawal it covers the copies later rounds carried from
 * it. Reopening only undoes a close made on purpose, never a fix. */
export function setFindingDismissed(id: string, dismissed: boolean): number {
  const chain = `WITH RECURSIVE chain(id) AS (
      SELECT ?
      UNION
      SELECT f.id FROM findings f INNER JOIN chain c ON f.carried_from_finding_id = c.id
    )`;
  const result = dismissed
    ? getAppDb()
        .prepare(
          `${chain} UPDATE findings SET state = 'closed', close_reason = 'dismissed'
           WHERE id IN (SELECT id FROM chain)`,
        )
        .run(id)
    : getAppDb()
        .prepare(
          `${chain} UPDATE findings SET state = 'open', close_reason = NULL
           WHERE id IN (SELECT id FROM chain)
             AND close_reason IN ('dismissed', 'withdrawn')`,
        )
        .run(id);
  return Number(result.changes ?? 0);
}

export function getFinding(id: string): FindingRow | undefined {
  return getAppDb()
    .prepare<FindingRow>(`SELECT * FROM findings WHERE id = ?`)
    .get(id);
}

export function setFindingPosted(
  id: string,
  postedCommentId: string,
  threadCommentId?: string,
): void {
  getAppDb()
    .prepare(
      `UPDATE findings SET posted_comment_id = ?, thread_comment_id = COALESCE(?, thread_comment_id) WHERE id = ?`,
    )
    .run(postedCommentId, threadCommentId ?? null, id);
}

export function listFindingsForReview(reviewId: string): FindingRow[] {
  return getAppDb()
    .prepare<FindingRow>(
      `SELECT * FROM findings WHERE review_id = ? ORDER BY severity, id`,
    )
    .all(reviewId);
}

export function listFindingsForPr(
  repo: string,
  prNumber: number,
): FindingRow[] {
  return getAppDb()
    .prepare<FindingRow>(
      `SELECT f.* FROM findings f
     INNER JOIN reviews r ON r.id = f.review_id
     WHERE r.repo = ? AND r.pr_number = ?
     ORDER BY r.round, f.id`,
    )
    .all(repo, prNumber);
}

export function findFindingByPostedComment(
  repo: string,
  prNumber: number,
  commentId: string,
): FindingRow | undefined {
  return getAppDb()
    .prepare<FindingRow>(
      `SELECT f.* FROM findings f
     INNER JOIN reviews r ON r.id = f.review_id
     WHERE r.repo = ? AND r.pr_number = ? AND f.posted_comment_id = ?
     ORDER BY r.created_at DESC LIMIT 1`,
    )
    .get(repo, prNumber, commentId);
}
