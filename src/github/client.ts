/** Shared by every `GitHubClient` implementation that talks over `fetch`
 * (pat.ts, and app.ts in P5). `GhClient` shells out to the `gh` binary,
 * which already retries on its own, so it never calls `githubFetch` — it
 * still shares `paginate`, the one 20-line loop every client used to carry
 * its own copy of. */

export class GitHubHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`GitHub API ${status}: ${body}`);
    this.name = "GitHubHttpError";
  }
}

export function isAccessDenied(error: unknown): boolean {
  return error instanceof GitHubHttpError &&
    (error.status === 403 || error.status === 404);
}

type RateLimit = { remaining: number; resetAt: Date };

function rateLimit(headers: Headers): RateLimit | undefined {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === null || reset === null) return undefined;
  return {
    remaining: Number(remaining),
    resetAt: new Date(Number(reset) * 1000),
  };
}

/** A secondary (abuse-detection) rate limit carries a short `retry-after`
 * and is retried in place, up to three attempts total. A primary limit at
 * zero remaining fails the request right away, with the reset time in the
 * message, rather than pausing the caller for however long that reset
 * takes — the caller decides whether to wait, not this function. */
export async function githubFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    response = await fetch(url, init);
    if (response.status !== 403 && response.status !== 429) return response;
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = retryAfterHeader === null
      ? NaN
      : Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter >= 0 && attempt < 3) {
      console.log(
        `[github] secondary rate limit, waiting ${retryAfter}s (attempt ${attempt} of 3)`,
      );
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }
    const limit = rateLimit(response.headers);
    if (limit && limit.remaining === 0) {
      throw new Error(
        `GitHub rate limit exhausted, resets at ${limit.resetAt.toISOString()}`,
      );
    }
    return response;
  }
  return response!;
}

export async function paginate<T>(
  request: (endpoint: string) => Promise<T[]>,
  endpoint: string,
  limit?: number,
  progress?: (page: number, fetched: number) => void,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1;; page++) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const pageItems = await request(
      `${endpoint}${separator}per_page=100&page=${page}`,
    );
    items.push(...pageItems);
    progress?.(page, items.length);
    if (
      pageItems.length < 100 ||
      (limit !== undefined && items.length >= limit)
    ) break;
  }
  return limit === undefined ? items : items.slice(0, limit);
}
