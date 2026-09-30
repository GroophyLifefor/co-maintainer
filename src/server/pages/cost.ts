/** How a review's cost renders on the dashboard. A missing cost
 * is never a silent `$0.00`: a single review says why in a tooltip, a total
 * names how many of its reviews are missing one. */
import { costReasonText, type CostReason } from "../../util/cost.ts";
import type { CostTotals } from "../../store/reviews.ts";
import { escapeHtml, money } from "./layout.ts";

export type CostRow = {
  cost: number | null;
  /** `null` on a row written before this column existed. */
  cost_status?: "known" | "unknown" | null;
  cost_note?: string | null;
  billed_to?: "server" | "byok" | null;
};

function statusOf(row: CostRow): "known" | "unknown" {
  return row.cost_status ?? (row.cost !== null ? "known" : "unknown");
}

/** One review's cost cell: the dollar amount, or "unknown" with the reason
 * as a tooltip. A row from before `cost_status` existed falls back to the
 * same rule the SQL aggregates use: a recorded cost is known, a missing one
 * is not. */
export function formatCost(row: CostRow): string {
  if (statusOf(row) === "known") return money(row.cost ?? 0);
  const reason =
    (row.cost_note as CostReason | null) ?? "recorded_before_0_5_1";
  return `<span class="cost-unknown" tabindex="0" title="${escapeHtml(
    costReasonText(reason),
  )}">unknown</span>`;
}

function reviewsWord(n: number): string {
  return `${n} review${n === 1 ? "" : "s"} with unknown cost`;
}

/** A figure summed from several reviews, as `$1.23 · 4 reviews with unknown
 * cost`. Plain text, safe wherever HTML cannot go (a `title` attribute, the
 * settings page's own JSON). BYOK never sits inside the main amount. */
export function formatCostTotal(totals: CostTotals): string {
  let main: string;
  if (totals.knownCount === 0 && totals.unknownCount > 0) {
    main = reviewsWord(totals.unknownCount);
  } else {
    main = money(totals.cost);
    if (totals.unknownCount > 0)
      main += ` · ${reviewsWord(totals.unknownCount)}`;
  }
  if (totals.byokKnownCount === 0 && totals.byokUnknownCount === 0) return main;
  const byok =
    totals.byokKnownCount === 0
      ? reviewsWord(totals.byokUnknownCount)
      : money(totals.byokUsd);
  return `${main} + ${byok} BYOK`;
}

/** Folds a handful of reviews (a pull request's rounds) into the same shape
 * `reviewStats` returns, so one review list and one SQL aggregate render
 * through the same `formatCostTotal`. */
export function totalOfRows(rows: CostRow[]): CostTotals {
  const totals: CostTotals = {
    cost: 0,
    knownCount: 0,
    unknownCount: 0,
    byokUsd: 0,
    byokKnownCount: 0,
    byokUnknownCount: 0,
  };
  for (const row of rows) {
    const known = statusOf(row) === "known";
    if (row.billed_to === "byok") {
      if (known) {
        totals.byokUsd += row.cost ?? 0;
        totals.byokKnownCount++;
      } else totals.byokUnknownCount++;
    } else if (known) {
      totals.cost += row.cost ?? 0;
      totals.knownCount++;
    } else totals.unknownCount++;
  }
  return totals;
}
