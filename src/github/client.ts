/** Shared by every `GitHubClient` implementation that talks over `fetch`
 * (pat.ts, and app.ts). `GhClient` shells out to the `gh` binary and does
 * not use `githubFetch`. Both paths share `paginate` and `waitForRateLimit`. */

import { createHash } from "node:crypto";
import { log } from "../util/log.ts";
import { networkFailure } from "../cli/error.ts";
import { missingHint, refusalHint } from "./permissions.ts";
import { recordRateLimitWait } from "../services/rate_limit.ts";
import { interrupted } from "../util/interrupt.ts";

export class GitHubHttpError extends Error {
  readonly status: number;
  /** GitHub refused the call for its rate limit, not for access. */
  readonly rateLimited: boolean;

  constructor(
    status: number,
    body: string,
    hint?: string,
    rateLimited = false,
  ) {
    super(`GitHub API ${status}: ${body}${hint ? ` ${hint}` : ""}`);
    this.status = status;
    this.rateLimited = rateLimited;
    this.name = "GitHubHttpError";
  }
}

/** A 403 or 429 GitHub sends for a rate limit: it carries `retry-after`,
 * a primary limit at zero, or a body that says so. A rate limit that outlived
 * the retries must not read as missing access. */
export function isRateLimitResponse(
  status: number,
  headers: Headers,
  body: string,
) {
  if (status === 429) return true;
  if (status !== 403) return false;
  return (
    headers.get("retry-after") !== null ||
    headers.get("x-ratelimit-remaining") === "0" ||
    /rate limit/i.test(body)
  );
}

/** A failed response as an error. A 403 or 404 names the endpoint and the
 * permission it needs, because GitHub's own body rarely says which one. */
export async function httpError(
  response: Response,
  method: string,
  endpoint: string,
  who: "token" | "App",
): Promise<GitHubHttpError> {
  const body = await response.text();
  const rateLimited = isRateLimitResponse(
    response.status,
    response.headers,
    body,
  );
  const hint = rateLimited
    ? "GitHub rate limited this call. It is temporary, try again later."
    : response.status === 403
      ? refusalHint(method, endpoint, who)
      : response.status === 404
        ? missingHint(method, endpoint, who)
        : undefined;
  return new GitHubHttpError(response.status, body, hint, rateLimited);
}

export function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof GitHubHttpError &&
    !error.rateLimited &&
    (error.status === 403 || error.status === 404)
  );
}

export function isRateLimited(error: unknown): boolean {
  return error instanceof GitHubHttpError && error.rateLimited;
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

/** How a rate limit wait sleeps. The simulate harness records the wait
 * and returns at once. */
const realRateLimitSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
let rateLimitSleep = realRateLimitSleep;

/** Test seam: replace the rate limit sleep. Unset puts the real one back. */
export function setRateLimitSleepForTest(
  fn?: (ms: number) => Promise<void>,
): void {
  rateLimitSleep = fn ?? realRateLimitSleep;
}

// One wait per installation and rate limit resource (0.7.32). A limit that
// one installation used up must not hold another installation's calls, and a
// search limit (minutes) must not hold a core limit (an hour). Calls that
// share a key wait out the same sleep.
const rateLimitGates = new Map<string, Promise<void>>();

function pauseForReset(
  resetAt: Date,
  delay: number,
  key = "default",
): Promise<void> {
  const open = rateLimitGates.get(key);
  if (open) return open;
  log(
    "github",
    `rate limit, next probe in ${Math.ceil(delay / 60_000)}m (reset ${resetLabel(resetAt)})`,
  );
  const pending = rateLimitSleep(delay).finally(() => {
    rateLimitGates.delete(key);
  });
  rateLimitGates.set(key, pending);
  return pending;
}

/** A content write waits for its place in the installation's schedule. The
 * wait is on the job's log, where Usage reads rate limit waits, and goes
 * through the same sleep the simulate harness replaces. */
export async function waitForContentSlot(ms: number): Promise<void> {
  recordRateLimitWait({
    service: "github",
    stage: "content write",
    reason: "content write limit (80 a minute, 500 an hour)",
    seconds: ms / 1000,
  });
  log(
    "github",
    `content write limit, waiting ${Math.ceil(ms / 1000)}s for its place`,
  );
  await rateLimitSleep(ms);
}

/** Sleep until `resetAt`, or at most `RATE_LIMIT_PROBE_MS`, whichever is
 * sooner. Throws once this attempt has already waited two hours. A `0`
 * delay returns immediately so the caller can try once more. */
export async function waitForRateLimit(
  resetAt: Date,
  startedAt: number,
  key = "default",
): Promise<void> {
  if (Date.now() - startedAt >= RATE_LIMIT_MAX_WAIT_MS) {
    throw rateLimitError(resetAt);
  }
  const delay = probeDelay(resetAt, Date.now());
  if (delay === 0) return;
  await pauseForReset(resetAt, delay, key);
}

/** The waits before each retry of a temporary GitHub failure: a 5xx or a
 * dropped connection. One such failure on a run of a thousand calls stopped
 * the whole run. Only reads are retried, a write may already have landed. */
const TRANSIENT_RETRY_DELAYS_MS = [2_000, 6_000];
let transientDelays = TRANSIENT_RETRY_DELAYS_MS;

/** Test seam: shorter waits. Unset puts the real ones back. */
export function setTransientDelaysForTest(delays?: number[]): void {
  transientDelays = delays ?? TRANSIENT_RETRY_DELAYS_MS;
}

/** The wait before retry number `retry` (0 based), or `undefined` once the
 * retries are spent. */
export function transientDelay(retry: number): number | undefined {
  return transientDelays[retry];
}

export function transientRetries(): number {
  return transientDelays.length;
}

/** A failure that is GitHub having a bad moment, not a wrong request: a 5xx,
 * or the connection dropping on the way. Matched on `gh`'s stderr and on the
 * fetch error text. */
export function isTransientFailure(text: string): boolean {
  return /HTTP 50[0234]\b|stream error|\bCANCEL\b|connection reset|unexpected EOF|i\/o timeout|TLS handshake timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(
    text,
  );
}

/** Reads, and GraphQL, which is a read sent as a POST. */
export function isRetryableRead(method: string, endpoint: string): boolean {
  return (
    method === "GET" || endpoint === "graphql" || endpoint.endsWith("/graphql")
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One `fetch`, retried while GitHub fails for a moment. A write is sent
 * once. */
async function fetchRetrying(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const read = isRetryableRead(init.method ?? "GET", url);
  for (let retry = 0; ; retry++) {
    const wait = read ? transientDelay(retry) : undefined;
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (wait === undefined) throw networkFailure(url, error);
      log(
        "github",
        `temporary GitHub error, retry ${retry + 1} of ${transientRetries()} in ${wait / 1000}s: ${String(error)}`,
      );
      await sleep(wait);
      // A Stop during the wait sends no retry.
      if (interrupted()) throw networkFailure(url, error);
      continue;
    }
    if (wait !== undefined && [500, 502, 503, 504].includes(response.status)) {
      log(
        "github",
        `temporary GitHub error (HTTP ${response.status}), retry ${retry + 1} of ${transientRetries()} in ${wait / 1000}s`,
      );
      await sleep(wait);
      if (interrupted()) return response;
      continue;
    }
    return response;
  }
}

/** True when a 403 or 429 says it is a secondary (abuse detection) limit. The
 * response is read from a copy, so the caller can still read it. */
async function isSecondaryLimit(response: Response): Promise<boolean> {
  if (response.status !== 403 && response.status !== 429) return false;
  try {
    const body = await response.clone().text();
    return /secondary rate limit|abuse detection/i.test(body);
  } catch {
    return false;
  }
}

/** The wait after attempt `attempt` (1 based) of a secondary limit that sent
 * no `retry-after`: a minute, then two, with up to a fifth more at random so
 * jobs that hit it together do not retry together. */
export function secondaryWaitSeconds(
  attempt: number,
  random: () => number = Math.random,
): number {
  return Math.round(60 * 2 ** (attempt - 1) * (1 + random() * 0.2));
}

/** Which installation and which limit a wait belongs to: the credential the
 * call carried, hashed so the wait table never holds it, and the limit
 * GitHub says the call counted against. */
function gateKey(init: RequestInit, response: Response): string {
  const headers = new Headers(init.headers);
  const credential = headers.get("authorization") ?? "";
  const who = credential
    ? createHash("sha256").update(credential).digest("hex").slice(0, 12)
    : "anonymous";
  return `${who}:${response.headers.get("x-ratelimit-resource") ?? "core"}`;
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
      response = await fetchRetrying(url, init);
      if (response.status !== 403 && response.status !== 429) return response;
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter =
        retryAfterHeader === null ? NaN : Number(retryAfterHeader);
      if (Number.isFinite(retryAfter) && retryAfter >= 0 && attempt < 3) {
        recordRateLimitWait({
          service: "github",
          stage: "GitHub request",
          reason: `secondary rate limit (HTTP ${response.status})`,
          seconds: retryAfter,
        });
        log(
          "github",
          `secondary rate limit, waiting ${retryAfter}s (attempt ${attempt} of 3)`,
        );
        await rateLimitSleep(retryAfter * 1000);
        // A Stop during the wait sends no retry.
        if (interrupted()) return response;
        continue;
      }
      const limit = rateLimit(response.headers);
      if (limit && limit.remaining === 0) {
        exhausted = limit;
        break;
      }
      // A secondary limit with no `retry-after` and requests left: GitHub says
      // to wait at least a minute, and longer each time it repeats.
      if (attempt < 3 && (await isSecondaryLimit(response))) {
        const seconds = secondaryWaitSeconds(attempt);
        recordRateLimitWait({
          service: "github",
          stage: "GitHub request",
          reason: `secondary rate limit without retry-after (HTTP ${response.status})`,
          seconds,
        });
        log(
          "github",
          `secondary rate limit without retry-after, waiting ${seconds}s (attempt ${attempt} of 3)`,
        );
        await rateLimitSleep(seconds * 1000);
        if (interrupted()) return response;
        continue;
      }
      return response;
    }
    if (!exhausted) return response!;
    const gate = gateKey(init, response!);
    const delay = probeDelay(exhausted.resetAt, Date.now());
    if (delay === 0) {
      if (spun) throw rateLimitError(exhausted.resetAt);
      spun = true;
      continue;
    }
    recordRateLimitWait({
      service: "github",
      stage: "GitHub request",
      reason: `primary rate limit (HTTP ${response?.status ?? 403})`,
      seconds: delay / 1000,
    });
    spun = false;
    await waitForRateLimit(exhausted.resetAt, started, gate);
    if (interrupted()) return response!;
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
