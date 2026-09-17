import { cancel } from "./jobs.ts";
import { listJobs, setJobStatus } from "../store/jobs.ts";
import { getReviewByJobId } from "../store/reviews.ts";

export function cancelRemoteJobsForToken(
  tokenId: string,
  reason: "token_deactivated" | "token_deleted",
): void {
  for (const job of listJobs()) {
    if (job.type !== "remote_review") continue;
    const review = getReviewByJobId(job.id);
    if (!review || review.token_id !== tokenId) continue;
    if (job.status === "queued") {
      setJobStatus(job.id, "canceled", { cancel_reason: reason });
    } else if (job.status === "running") {
      cancel(job.id, reason);
    }
  }
}
