import { getReviewByJobId, setReviewStatus } from "../store/reviews.ts";

/** Queued remote reviews never enter the handler; sync the review row when the
 * job is canceled from the dashboard or token deactivation. */
export function abortQueuedRemoteReviewRow(jobId: string): void {
  const review = getReviewByJobId(jobId);
  if (!review || review.kind !== "remote") return;
  if (review.status !== "queued") return;
  setReviewStatus(review.id, "aborted");
}
