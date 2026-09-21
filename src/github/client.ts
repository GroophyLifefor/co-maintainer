/** Shared by every `GitHubClient` implementation that talks over `fetch`
 * (pat.ts, and app.ts). `GhClient` shells out to the `gh` binary and does
 * not use `githubFetch`; both paths share `paginate` and `waitForRateLimit`. */

import { log } from "../util/log.ts";

export class GitHubHttpError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`GitHub API ${status}: ${body}`);
    this.status = status;
    this.name = "GitHubHttpError";
  }
}

export function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof GitHubHttpError &&
    (error.status === 403 || error.status === 404)
  );
}

type RateLimit = { remaining: number; resetAt: Date };

/** Primary probes wake at the reset, but at least every half hour. */
export const RATE_LIMIT_PROBE_MS = 30 * 60 * 1000;
/** A sliding reset header must not pin a serve job. */
const RATE_LIMIT_MAX_WAIT_MS = 2 * 60 * 60 * 1000;

function rateLimit(headers: Headers): RateLimit | undefined {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === null || reset === null) return undefined;
  return {
    remaining: Number(remaining),
    resetAt: new Date(Number(reset) * 1000),
  };
}

/** How long to sleep before the next try. A past reset is `0` (try now).
 * An unreadable reset is one probe interval. */
export function probeDelay(resetAt: Date, now: number): number {
  const until = resetAt.getTime() - now;
  if (!Number.isFinite(until)) return RATE_LIMIT_PROBE_MS;
  if (until <= 0) return 0;
  return Math.min(until, RATE_LIMIT_PROBE_MS);
}

export function rateLimitError(resetAt: Date): Error {
  const when = Number.isFinite(resetAt.getTime())
    ? resetAt.toISOString()
    : "unknown";
  return new Error(`GitHub rate limit exhausted, resets at ${when}`);
}

function resetLabel(resetAt: Date): string {
  return Number.isFinite(resetAt.getTime()) ? resetAt.toISOString() : "unknown";
}

// ponytail: one process-wide sleep. A search limit (minutes) and a core
// limit (an hour) exhausted together wait out the longer one.
let rateLimitGate: Promise<void> | undefined;

function pauseForReset(resetAt: Date, delay: number): Promise<void> {
  if (rateLimitGate) return rateLimitGate;
  log(
    "github",
    `rate limit, next probe in ${Math.ceil(delay / 60_000)}m (reset ${resetLabel(resetAt)})`,
  );
  const pending = new Promise<void>((resolve) => {
    setTimeout(resolve, delay);
  });
  rateLimitGate = pending.finally(() => {
    rateLimitGate = undefined;
  });
  return rateLimitGate;
}

/** Sleep until `resetAt`, or at most `RATE_LIMIT_PROBE_MS`, whichever is
 * sooner. Throws once this attempt has already waited two hours. A `0`
 * delay returns immediately so the caller can try once more. */
export async function waitForRateLimit(
  resetAt: Date,
  startedAt: number,
): Promise<void> {
  if (Date.now() - startedAt >= RATE_LIMIT_MAX_WAIT_MS) {
    throw rateLimitError(resetAt);
  }
  const delay = probeDelay(resetAt, Date.now());
  if (delay === 0) return;
  await pauseForReset(resetAt, delay);
}

/** A secondary (abuse-detection) rate limit carries a short `retry-after`
 * and is retried in place, up to three attempts total. A primary limit at
 * zero remaining sleeps until its reset, probing at least every 30 minutes,
 * then retries the same request. */
export async function githubFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const started = Date.now();
  let spun = false;
  for (;;) {
    let response: Response | undefined;
    let exhausted: RateLimit | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      response = await fetch(url, init);
      if (response.status !== 403 && response.status !== 429) return response;
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter =
        retryAfterHeader === null ? NaN : Number(retryAfterHeader);
      if (Number.isFinite(retryAfter) && retryAfter >= 0 && attempt < 3) {
        console.log(
          `[github] secondary rate limit, waiting ${retryAfter}s (attempt ${attempt} of 3)`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      const limit = rateLimit(response.headers);
      if (limit && limit.remaining === 0) {
        exhausted = limit;
        break;
      }
      return response;
    }
    if (!exhausted) return response!;
    const delay = probeDelay(exhausted.resetAt, Date.now());
    if (delay === 0) {
      if (spun) throw rateLimitError(exhausted.resetAt);
      spun = true;
      continue;
    }
    spun = false;
    await waitForRateLimit(exhausted.resetAt, started);
  }
}

export async function paginate<T>(
  request: (endpoint: string) => Promise<T[]>,
  endpoint: string,
  limit?: number,
  progress?: (page: number, fetched: number) => void,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const pageItems = await request(
      `${endpoint}${separator}per_page=100&page=${page}`,
    );
    items.push(...pageItems);
    progress?.(page, items.length);
    if (
      pageItems.length < 100 ||
      (limit !== undefined && items.length >= limit)
    )
      break;
  }
  return limit === undefined ? items : items.slice(0, limit);
}
