import { getReviewByJobId, setReviewStatus } from "../store/reviews.ts";
import { deleteRemoteReviewInput } from "../store/remote_review_inputs.ts";
import { dropByokKey } from "../remote/server/byok_keys.ts";

/** Queued remote reviews never enter the handler; sync the review row when the
 * job is canceled from the dashboard or token deactivation. The BYOK key and
 * the input row are dropped here too: a queued job canceled before it ever
 * runs must not leave the client's key in memory, and a later retry with the
 * same request id must be free to start over instead of finding a dead row
 * whose key is gone. */
export function abortQueuedRemoteReviewRow(jobId: string): void {
  dropByokKey(jobId);
  deleteRemoteReviewInput(jobId);
  const review = getReviewByJobId(jobId);
  if (!review || review.kind !== "remote") return;
  if (review.status !== "queued") return;
  setReviewStatus(review.id, "aborted");
}
