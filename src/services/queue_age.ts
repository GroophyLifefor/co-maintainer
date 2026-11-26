/** A review that waited in the queue too long is skipped, not run late
 * (0.7.32). A pull request whose review was queued a day ago has usually moved
 * on: a push queued a newer job, or the author gave up. The pull request
 * gets one line saying so, and a push or a review request starts a fresh job
 * that waits from zero. */
import { readConfig, type UserConfig } from "../config.ts";
import { getAppDb } from "../store/app_db.ts";
import type { JobRow } from "../store/rows.ts";

export const DEFAULT_QUEUE_MAX_AGE_HOURS = 24;
/** Below this the limit would skip a job that waits one GitHub content
 * window, an hour, for its turn. */
export const MIN_QUEUE_MAX_AGE_HOURS = 2;
export const QUEUED_TOO_LONG = "queued_too_long";
/** The same skip when the note could not be posted. It does not count as a
 * note, so the next old job for the pull request tries again. */
export const QUEUED_TOO_LONG_NO_NOTE = "queued_too_long_no_note";

/** True for either reason: the job was skipped for waiting too long. */
export function isQueuedTooLong(reason: string | null | undefined): boolean {
  return reason === QUEUED_TOO_LONG || reason === QUEUED_TOO_LONG_NO_NOTE;
}

/** Pull requests a job is noting right now, so two old jobs that run at once
 * do not both post. The cancellation that `alreadyNoted` reads comes later. */
const noting = new Set<string>();

/** Claims the note for this pull request. False when another job holds it. */
export function claimNote(repo: string, prNumber: number): boolean {
  const key = `${repo}#${String(prNumber)}`;
  if (noting.has(key)) return false;
  noting.add(key);
  return true;
}

export function releaseNote(repo: string, prNumber: number): void {
  noting.delete(`${repo}#${String(prNumber)}`);
}
/** Hidden in the note so a later reader can tell it from a person's comment. */
export const QUEUED_TOO_LONG_MARKER = "<!-- co-maintainer:queued-too-long -->";

export const QUEUED_TOO_LONG_NOTE = `${QUEUED_TOO_LONG_MARKER}
This pull request waited too long in the review queue, so it was not reviewed. Push again or ask for a review.`;

/** The limit in milliseconds. Unset, zero, negative or not a number means
 * the default, and a value under the minimum is raised to it. */
export function queueMaxAgeMs(config: UserConfig = readConfig()): number {
  const hours = config.queueMaxAgeHours;
  const valid =
    typeof hours === "number" && Number.isFinite(hours) && hours > 0;
  const chosen = valid ? hours : DEFAULT_QUEUE_MAX_AGE_HOURS;
  return Math.max(chosen, MIN_QUEUE_MAX_AGE_HOURS) * 3_600_000;
}

/** True when the job has waited longer than the limit. A job that already
 * started (a rerun after a restart) is not skipped. */
export function waitedTooLong(
  job: Pick<JobRow, "created_at" | "started_at">,
  nowMs: number = Date.now(),
  limitMs: number = queueMaxAgeMs(),
): boolean {
  const created = Date.parse(job.created_at);
  if (!Number.isFinite(created)) return false;
  return nowMs - created > limitMs;
}

/** True when this pull request already got the note inside the limit, so a
 * long outage does not note the same pull request again for every job. */
export function alreadyNoted(
  repo: string,
  prNumber: number,
  nowMs: number = Date.now(),
  limitMs: number = queueMaxAgeMs(),
): boolean {
  const since = new Date(nowMs - limitMs).toISOString();
  const row = getAppDb()
    .prepare(
      `SELECT 1 AS found FROM jobs
       WHERE repo = ? AND pr_number = ? AND cancel_reason = ? AND finished_at > ?
       LIMIT 1`,
    )
    .get(repo, prNumber, QUEUED_TOO_LONG, since) as
    | { found: number }
    | undefined;
  return row !== undefined;
}
