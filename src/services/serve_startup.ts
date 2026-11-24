/** What `serve` does with jobs before it listens, in one place, so the
 * simulated server runs the same code: every job handler registered, then
 * the jobs a previous process left unfinished recovered. */
import { removeServeRunFolders } from "../extensions/run_folder.ts";
import { listJobs } from "../store/jobs.ts";
import { recoverOrphans } from "./jobs.ts";
import { registerPushReviewHandlers } from "./push_review.ts";
import { registerRemoteReviewHandler } from "./remote_review.ts";
import { recoverReplyRequests, registerReplyJobHandler } from "./replies.ts";
import { registerReviewJobHandler } from "./review.ts";
import { registerSetupJobHandler } from "./setup.ts";
import { registerSkipJobHandler } from "./skip_commands.ts";
import { registerWatchCommentHandler } from "./watch_comments.ts";

export function registerJobHandlers(): void {
  registerSetupJobHandler();
  registerReviewJobHandler();
  registerRemoteReviewHandler();
  registerReplyJobHandler();
  registerPushReviewHandlers();
  registerWatchCommentHandler();
  registerSkipJobHandler();
}

/** Jobs a killed process left `running` are reconciled or run again, and
 * unfinished conversation replies are queued again. */
export async function recoverUnfinishedJobs(): Promise<{
  orphans: number;
  replies: number;
}> {
  // Before the orphans run again: a job still marked running keeps its
  // extension folder, which tells its rerun what the restart cut off.
  await removeServeRunFolders(
    new Set(listJobs({ status: "running" }).map((job) => job.id)),
  );
  const orphans = await recoverOrphans();
  const replies = recoverReplyRequests();
  return { orphans, replies };
}
