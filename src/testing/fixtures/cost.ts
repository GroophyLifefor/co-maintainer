/** The `setReviewStatus` patch a real review write uses for a known cost
 * (`costColumns(settle(tally))` in production code). Test fixtures that seed
 * a review directly, instead of running an AI call through it, use this so
 * the row does not sit at the `unknown` / `not_recorded` status every new
 * review starts at. */
export function KNOWN_COST(usd: number): {
  cost: number;
  cost_status: "known";
  cost_note: null;
} {
  return { cost: usd, cost_status: "known", cost_note: null };
}
