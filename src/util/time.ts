/** The one place every stored timestamp comes from. PLAN.md Section 3's
 * "every timestamp is ISO8601 UTC" rule lives here instead of as a
 * convention repeated at each call site — `store/*` never calls
 * `new Date().toISOString()` directly. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Short relative label for dashboard tables. Never emits a dash or
 * semicolon. */
export function relativeTime(iso: string, nowMs = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const sec = Math.max(0, Math.round((nowMs - then) / 1000));
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
  const hour = Math.round(min / 60);
  if (hour < 24) return hour === 1 ? "1 hour ago" : `${hour} hours ago`;
  const day = Math.round(hour / 24);
  if (day === 1) return "yesterday";
  if (day < 30) return `${day} days ago`;
  const month = Math.round(day / 30);
  if (month < 12) return month === 1 ? "1 month ago" : `${month} months ago`;
  const year = Math.round(day / 365);
  return year === 1 ? "1 year ago" : `${year} years ago`;
}

export function daysAgoIso(days: number, nowMs = Date.now()): string {
  return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}
