/** One count of open failures for the whole dashboard: the menu badge, the
 * home list and the repository overview all read it, and each opens the
 * failed Activity list with the same window, so the number on the link is
 * the number of rows it opens.
 *
 * Open means nobody dismissed it and no later review resolved it. The window
 * starts at the beginning of the day 30 days ago, in UTC, because the
 * Activity date filter works in whole days. */
import {
  openFailureCount,
  openFailureCountsByRepo,
} from "../store/failures.ts";

export const OPEN_FAILURE_DAYS = 30;

/** The first day of the window, `YYYY-MM-DD`, and its start as an ISO time. */
export function openFailureWindow(nowMs = Date.now()): {
  day: string;
  sinceIso: string;
} {
  const start = new Date(nowMs);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - OPEN_FAILURE_DAYS);
  const sinceIso = start.toISOString();
  return { day: sinceIso.slice(0, 10), sinceIso };
}

export function openFailures(repo?: string, nowMs = Date.now()): number {
  return openFailureCount(openFailureWindow(nowMs).sinceIso, repo);
}

export function openFailuresByRepo(nowMs = Date.now()): Map<string, number> {
  return openFailureCountsByRepo(openFailureWindow(nowMs).sinceIso);
}

/** The failed Activity list these counts come from. */
export function openFailuresHref(repo?: string, nowMs = Date.now()): string {
  const params = new URLSearchParams();
  if (repo) params.set("repo", repo);
  params.set("status", "failed");
  params.set("from", openFailureWindow(nowMs).day);
  return `/activity?${params.toString()}`;
}
