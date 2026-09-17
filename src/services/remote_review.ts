import { readConfig } from "../config.ts";
import { cancel, registerHandler, type LogFn } from "./jobs.ts";
import { findRepoByFullName } from "../store/repos.ts";
import {
  findRemoteReviewInputByRequest,
  insertRemoteReviewInput,
} from "../store/remote_review_inputs.ts";
import {
  deleteSubjectRevision,
  getOrCreateRemoteSubject,
} from "../store/subjects.ts";
import {
  getReviewByJobId,
  insertRemoteReview,
  setReviewStatus,
} from "../store/reviews.ts";
import { insertJob, listJobsByQueueKey, setJobStatus } from "../store/jobs.ts";
import type { RemoteTokenRow } from "../store/rows.ts";
import type { JobRow } from "../store/rows.ts";

const REPO_UNAVAILABLE =
  "Sorry, we could not access this repository.";

function remoteQueueKey(repo: string, branch: string, tokenId: string): string {
  return `remote:${repo}:${branch}:${tokenId}`;
}

function supersedeActiveRemoteJobs(
  queueKey: string,
  supersededBy: string,
): void {
  for (const job of listJobsByQueueKey(queueKey, ["queued", "running"])) {
    if (job.id === supersededBy) continue;
    if (job.status === "running") {
      cancel(job.id, "superseded");
    } else {
      setJobStatus(job.id, "canceled", {
        superseded_by: supersededBy,
        cancel_reason: "superseded",
      });
    }
  }
}

export function submitRemoteReview(
  token: RemoteTokenRow,
  body: Record<string, unknown>,
): { jobId: string; reviewId: string } | { error: string; status: number; code: string } {
  const requestId = String(body.requestId);
  const existing = findRemoteReviewInputByRequest(token.id, requestId);
  if (existing) {
    const review = getReviewByJobId(existing.job_id);
    if (review) {
      return { jobId: existing.job_id, reviewId: review.id };
    }
  }

  const repoRow = findRepoByFullName(String(body.repo));
  if (!repoRow || repoRow.active !== 1) {
    return { error: REPO_UNAVAILABLE, status: 404, code: "repo_unavailable" };
  }

  const branch = String(body.branch);
  const fresh = body.fresh === true;
  const subject = getOrCreateRemoteSubject(
    repoRow.full_name,
    branch,
    token.id,
  );
  if (fresh) deleteSubjectRevision(subject.id);

  const jobId = crypto.randomUUID();
  const reviewId = crypto.randomUUID();
  const queueKey = remoteQueueKey(repoRow.full_name, branch, token.id);
  supersedeActiveRemoteJobs(queueKey, jobId);

  const revision = body.revision ?? {};
  const capabilities = body.capabilities ?? { tools: [] };
  insertRemoteReviewInput({
    jobId,
    revisionJson: JSON.stringify(revision),
    capabilitiesJson: JSON.stringify(capabilities),
    requestId,
    tokenId: token.id,
  });

  const config = readConfig();
  insertRemoteReview({
    id: reviewId,
    subjectId: subject.id,
    repo: repoRow.full_name,
    branch,
    tokenId: token.id,
    tokenName: token.name,
    jobId,
    scope: "remote",
    model: config.highModel ?? "unknown",
  });

  insertJob({
    id: jobId,
    type: "remote_review",
    repo: repoRow.full_name,
    queueKey,
    args: { subjectId: subject.id, requestId, reviewId },
  });

  return { jobId, reviewId };
}

export function registerRemoteReviewHandler(): void {
  registerHandler("remote_review", {
    async run(job: JobRow, log: LogFn, signal: AbortSignal) {
      const args = JSON.parse(job.args) as {
        reviewId?: string;
      };
      const reviewId = args.reviewId;
      log("info", "remote review worker stub — full engine pending");
      if (signal.aborted) return;
      if (reviewId) {
        setReviewStatus(reviewId, "aborted");
      }
      throw new Error("remote review engine is not implemented yet");
    },
  });
}
