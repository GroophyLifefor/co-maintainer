/** How many GitHub requests an installation has left this hour, and whether a
 * review may start on it (0.7.33).
 *
 * GitHub tells every answer how many requests an installation has left
 * (`x-ratelimit-remaining`) and when the hour resets. A review that starts
 * with too little left stops halfway, holding a slot until the reset, and the
 * other installations' jobs wait behind it. So a queued review starts only
 * when what is left covers it and the reviews already running, with a tenth
 * kept back for the writes that close a review (its check run, a failure
 * note). A review that cannot start stays queued. It is not failed. */

/** The requests one review is expected to make, with room for a large one.
 * The smallest review makes 9 (measured, `--flow=gh-calls`). */
export const REVIEW_COST = 14;
/** The part of the hour's allowance kept back for closing writes. */
export const RESERVE_SHARE = 0.1;

type Budget = { limit: number; remaining: number; resetAtMs: number };

const budgets = new Map<number, Budget>();

/** Reads the limit headers of an answer for this installation's core limit. */
export function noteRateLimit(installationId: number, headers: Headers): void {
  const resource = headers.get("x-ratelimit-resource");
  if (resource !== null && resource !== "core") return;
  const limit = Number(headers.get("x-ratelimit-limit"));
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (![limit, remaining, reset].every(Number.isFinite)) return;
  if (headers.get("x-ratelimit-remaining") === null) return;
  budgets.set(installationId, {
    limit,
    remaining,
    resetAtMs: reset * 1000,
  });
}

/** True when a review may start on this installation. With nothing known, or
 * after the reset, it may. `running` is how many reviews of this installation
 * are already running: they have not spent their share yet. */
export function mayStartReview(
  installationId: number | undefined,
  running: number,
  nowMs: number = Date.now(),
): boolean {
  if (installationId === undefined) return true;
  const budget = budgets.get(installationId);
  if (!budget || nowMs >= budget.resetAtMs) return true;
  const reserve = Math.ceil(budget.limit * RESERVE_SHARE);
  return budget.remaining - (running + 1) * REVIEW_COST >= reserve;
}

/** Test seam: forget what every installation had left. */
export function resetBudgetsForTest(): void {
  budgets.clear();
}
