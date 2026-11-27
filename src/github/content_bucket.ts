/** GitHub limits content-generating requests (a review, a comment) to 80 a
 * minute and 500 an hour for an installation. A burst of finished reviews
 * would hit the limit and GitHub would answer with a secondary rate limit.
 * This spaces the writes before they are sent (0.7.33).
 *
 * Each write is given the earliest time at which neither window is full,
 * counting the writes already given a time, so any number of reviews that ask
 * at once are spread out instead of all waiting for the same moment. */
import { readConfig, type UserConfig } from "../config.ts";

export const CONTENT_PER_MINUTE = 80;
export const DEFAULT_CONTENT_PER_HOUR = 450;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** The hourly allowance: 450 unless set, never over GitHub's 500. */
export function contentPerHour(config: UserConfig = readConfig()): number {
  const value = config.contentWritesPerHour;
  const valid =
    typeof value === "number" && Number.isFinite(value) && value > 0;
  return Math.min(Math.floor(valid ? value : DEFAULT_CONTENT_PER_HOUR), 500);
}

/** True for the requests GitHub counts as content: a review, a comment on the
 * pull request conversation, a line comment. Check runs and reads are not. */
export function isContentWrite(method: string, endpoint: string): boolean {
  if (method !== "POST") return false;
  return /(^|\/)(pulls\/\d+\/(reviews|comments)|issues\/\d+\/comments)$/.test(
    endpoint.split("?")[0] ?? endpoint,
  );
}

export class ContentSchedule {
  private readonly slots: number[] = [];

  /** The time this write may go out. Records it. */
  reserve(
    now: number,
    perMinute: number = CONTENT_PER_MINUTE,
    perHour: number = contentPerHour(),
  ): number {
    // Forget what no window can see any more.
    while (this.slots.length > 0 && this.slots[0]! <= now - HOUR) {
      this.slots.shift();
    }
    const full = (at: number) =>
      this.slots.filter((s) => s > at - MINUTE && s <= at).length >=
        perMinute ||
      this.slots.filter((s) => s > at - HOUR && s <= at).length >= perHour;
    // The only times worth trying: now, and the moment a slot leaves a window.
    const candidates = [
      now,
      ...this.slots.flatMap((s) => [s + MINUTE, s + HOUR]),
    ]
      .filter((t) => t >= now)
      .sort((a, b) => a - b);
    const at = candidates.find((t) => !full(t)) ?? now;
    this.slots.push(at);
    this.slots.sort((a, b) => a - b);
    return at;
  }

  /** Gives back a slot that was reserved and never used. */
  release(at: number): void {
    const index = this.slots.indexOf(at);
    if (index >= 0) this.slots.splice(index, 1);
  }
}

const schedules = new Map<number, ContentSchedule>();

function scheduleFor(installationId: number): ContentSchedule {
  let schedule = schedules.get(installationId);
  if (!schedule) {
    schedule = new ContentSchedule();
    schedules.set(installationId, schedule);
  }
  return schedule;
}

/** The place a running review holds for its first content write. */
const tickets = new Map<string, { installationId: number; at: number }>();

/** A review takes its place when it starts, before the model's work, so the
 * reviews that start together are spread out then and not all at the moment
 * they finish (0.7.35). The review's own write uses this place. */
export function reserveJobSlot(
  jobId: string,
  installationId: number,
  now: number = Date.now(),
): void {
  if (tickets.has(jobId)) return;
  tickets.set(jobId, {
    installationId,
    at: scheduleFor(installationId).reserve(now),
  });
}

/** Gives back the place a job did not use, such as a review that failed or
 * posted nothing. Safe to call for a job with no place. */
export function releaseJobSlot(jobId: string): void {
  const ticket = tickets.get(jobId);
  if (!ticket) return;
  tickets.delete(jobId);
  scheduleFor(ticket.installationId).release(ticket.at);
}

/** The wait in milliseconds before a content write for this installation.
 * The first write of a job that holds a place uses it. Any other write takes
 * a new place. */
export function contentWriteDelay(
  installationId: number,
  now: number = Date.now(),
  jobId?: string,
): number {
  const ticket = jobId === undefined ? undefined : tickets.get(jobId);
  if (
    jobId !== undefined &&
    ticket &&
    ticket.installationId === installationId
  ) {
    tickets.delete(jobId);
    return Math.max(0, ticket.at - now);
  }
  return Math.max(0, scheduleFor(installationId).reserve(now) - now);
}

/** Test seam: forget every installation's writes. */
export function resetContentSchedulesForTest(): void {
  schedules.clear();
  tickets.clear();
}
