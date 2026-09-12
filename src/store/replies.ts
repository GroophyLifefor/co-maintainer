import { getAppDb } from "./app_db.ts";
import { insertJob } from "./jobs.ts";
import { nowIso } from "../util/time.ts";
import type { ReplyRequestRow } from "./rows.ts";

export type ReplyRequestInput = {
  repo: string;
  prNumber: number;
  sourceKind: "review_comment" | "issue_comment";
  sourceCommentId: string;
  targetCommentId?: string;
  sourceBody: string;
  sourceAuthor?: string;
  sourcePath?: string;
  sourceLine?: number;
  sourceCommitId?: string;
  deliveryId?: string;
};

export function createReplyRequestAndJob(
  input: ReplyRequestInput,
): { request: ReplyRequestRow; created: boolean } {
  const existing = findReplyRequest(
    input.repo,
    input.sourceKind,
    input.sourceCommentId,
  );
  if (existing) return { request: existing, created: false };

  const db = getAppDb();
  const requestId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const now = nowIso();
  const queueKey =
    `reply:${input.repo}:${input.sourceKind}:${input.sourceCommentId}`;
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO reply_requests
         (id, repo, pr_number, source_kind, source_comment_id,
          target_comment_id, source_body, source_author, source_path,
          source_line, source_commit_id, status, job_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(
      requestId,
      input.repo,
      input.prNumber,
      input.sourceKind,
      input.sourceCommentId,
      input.targetCommentId ?? null,
      input.sourceBody,
      input.sourceAuthor ?? null,
      input.sourcePath ?? null,
      input.sourceLine ?? null,
      input.sourceCommitId ?? null,
      jobId,
      now,
      now,
    );
    insertJob({
      id: jobId,
      type: "reply",
      repo: input.repo,
      prNumber: input.prNumber,
      args: { requestId },
      deliveryId: input.deliveryId,
      queueKey,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { request: getReplyRequest(requestId)!, created: true };
}

export function getReplyRequest(id: string): ReplyRequestRow | undefined {
  return getAppDb().prepare<ReplyRequestRow>(
    `SELECT * FROM reply_requests WHERE id = ?`,
  ).get(id);
}

export function findReplyRequest(
  repo: string,
  sourceKind: string,
  sourceCommentId: string,
): ReplyRequestRow | undefined {
  return getAppDb().prepare<ReplyRequestRow>(
    `SELECT * FROM reply_requests
     WHERE repo = ? AND source_kind = ? AND source_comment_id = ?`,
  ).get(repo, sourceKind, sourceCommentId);
}

export function findReplyByPostedComment(
  repo: string,
  prNumber: number,
  commentId: string,
): ReplyRequestRow | undefined {
  return getAppDb().prepare<ReplyRequestRow>(
    `SELECT * FROM reply_requests
     WHERE repo = ? AND pr_number = ? AND posted_comment_id = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(repo, prNumber, commentId);
}

export function setReplyStatus(
  id: string,
  status: ReplyRequestRow["status"],
  patch: Partial<
    Pick<ReplyRequestRow, "answer_md" | "posted_comment_id" | "error">
  > = {},
): void {
  const attempts = status === "generating" || status === "posting" ? 1 : 0;
  getAppDb().prepare(
    `UPDATE reply_requests SET
       status = ?,
       answer_md = COALESCE(?, answer_md),
       posted_comment_id = COALESCE(?, posted_comment_id),
       error = COALESCE(?, error),
       attempts = attempts + ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    status,
    patch.answer_md ?? null,
    patch.posted_comment_id ?? null,
    patch.error ?? null,
    attempts,
    nowIso(),
    id,
  );
}

export function setReplyJobId(id: string, jobId: string): void {
  getAppDb().prepare(
    `UPDATE reply_requests SET job_id = ?, updated_at = ? WHERE id = ?`,
  ).run(jobId, nowIso(), id);
}

export function listRecoverableReplies(): ReplyRequestRow[] {
  return getAppDb().prepare<ReplyRequestRow>(
    `SELECT * FROM reply_requests
     WHERE status IN ('queued', 'generating', 'ready', 'posting')
     ORDER BY created_at`,
  ).all();
}
