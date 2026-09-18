import { cancel, getLogsSince } from "../../services/jobs.ts";
import { errorResponse } from "../../server/errors.ts";
import { redact } from "../../util/redact.ts";
import { getJob } from "../../store/jobs.ts";
import { getReviewByJobId } from "../../store/reviews.ts";
import type { RemoteTokenRow } from "../../store/rows.ts";
import { REMOTE_SCHEMA_VERSION } from "../schema.ts";
import {
  validateSyncRequest,
  validateSyncResponseStatus,
} from "../validate.ts";
import {
  getRemoteSyncResult,
  touchRemoteSession,
  type RemoteSyncResult,
} from "./sessions.ts";
import { applyToolResults, drainPendingToolCalls } from "../tool_bridge.ts";

function jobToSyncStatus(
  jobStatus: string,
): "queued" | "running" | "done" | "failed" | "canceled" {
  switch (jobStatus) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "failed";
  }
}

export function handleRemoteSync(
  jobId: string,
  token: RemoteTokenRow,
  body: Record<string, unknown>,
): Response {
  const validation = validateSyncRequest(body);
  if (validation) {
    return errorResponse(400, "bad_request", validation);
  }

  const job = getJob(jobId);
  const review = getReviewByJobId(jobId);
  if (!job || !review || review.token_id !== token.id) {
    return errorResponse(404, "not_found", "review not found");
  }

  touchRemoteSession(jobId);

  const toolResults = body.toolResults;
  if (Array.isArray(toolResults)) {
    applyToolResults(
      jobId,
      toolResults as Array<{ callId: string; output?: string; error?: string }>,
    );
  }

  const afterLogSeq = Number(body.afterLogSeq);
  const logs = getLogsSince(jobId, afterLogSeq).map((row) => ({
    seq: row.seq,
    at: row.at,
    level: row.level,
    message: row.message,
  }));

  const status = jobToSyncStatus(job.status);
  const statusErr = validateSyncResponseStatus(status);
  if (statusErr) {
    return errorResponse(500, "internal", statusErr);
  }

  let abort: { reason: string; message: string } | null = null;
  let result: RemoteSyncResult | null = null;

  if (status === "done") {
    result = getRemoteSyncResult(jobId) ?? null;
  } else if (status === "canceled") {
    const reason = job.cancel_reason ?? "canceled";
    abort = {
      reason,
      message:
        reason === "client_timeout"
          ? "No sync received for the configured timeout."
          : "Review was canceled.",
    };
  } else if (status === "failed") {
    abort = {
      reason: "failed",
      message: redact(job.error ?? "Review failed."),
    };
  }

  const toolCalls = drainPendingToolCalls(jobId);

  return Response.json({
    schemaVersion: REMOTE_SCHEMA_VERSION,
    status,
    toolCalls,
    logs,
    result,
    abort,
  });
}

export function handleRemoteCancel(
  jobId: string,
  token: RemoteTokenRow,
): Response {
  const review = getReviewByJobId(jobId);
  if (!review || review.token_id !== token.id) {
    return errorResponse(404, "not_found", "review not found");
  }
  cancel(jobId, "client_canceled");
  return new Response(null, { status: 204 });
}
