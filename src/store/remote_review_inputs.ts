import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import type { RemoteReviewInputRow } from "./rows.ts";

export function insertRemoteReviewInput(input: {
  jobId: string;
  revisionJson: string;
  capabilitiesJson: string;
  requestId: string;
  tokenId: string;
}): void {
  getAppDb().prepare(
    `INSERT INTO remote_review_inputs
      (job_id, revision_json, capabilities_json, request_id, token_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.jobId,
    input.revisionJson,
    input.capabilitiesJson,
    input.requestId,
    input.tokenId,
    nowIso(),
  );
}

export function findRemoteReviewInputByRequest(
  tokenId: string,
  requestId: string,
): RemoteReviewInputRow | undefined {
  return getAppDb().prepare<RemoteReviewInputRow>(
    `SELECT * FROM remote_review_inputs
     WHERE token_id = ? AND request_id = ?`,
  ).get(tokenId, requestId);
}

export function getRemoteReviewInput(
  jobId: string,
): RemoteReviewInputRow | undefined {
  return getAppDb().prepare<RemoteReviewInputRow>(
    `SELECT * FROM remote_review_inputs WHERE job_id = ?`,
  ).get(jobId);
}

export function deleteRemoteReviewInput(jobId: string): void {
  getAppDb().prepare(`DELETE FROM remote_review_inputs WHERE job_id = ?`).run(
    jobId,
  );
}
