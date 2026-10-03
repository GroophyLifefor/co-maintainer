import { test } from "node:test";
import { formatCost, formatCostTotal, totalOfRows } from "./cost.ts";
import type { CostTotals } from "../../store/reviews.ts";

function totals(patch: Partial<CostTotals> = {}): CostTotals {
  return {
    cost: 0,
    knownCount: 0,
    unknownCount: 0,
    byokUsd: 0,
    byokKnownCount: 0,
    byokUnknownCount: 0,
    ...patch,
  };
}

test("formatCost: a known cost is the dollar amount, a real zero included", () => {
  if (formatCost({ cost: 0.0023, cost_status: "known" }) !== "$0.0023") {
    throw new Error(formatCost({ cost: 0.0023, cost_status: "known" }));
  }
  if (formatCost({ cost: 0, cost_status: "known" }) !== "$0.00") {
    throw new Error(formatCost({ cost: 0, cost_status: "known" }));
  }
});

test("formatCost: an unknown cost never reads $0.00, and names why", () => {
  const html = formatCost({
    cost: null,
    cost_status: "unknown",
    cost_note: "partial",
  });
  if (html.includes("$0.00")) throw new Error(html);
  if (!/>unknown</.test(html)) throw new Error(html);
  if (!html.includes("Some AI calls in this review did not report a cost")) {
    throw new Error(html);
  }
});

test("formatCost: a row from before cost_status existed falls back on cost", () => {
  if (formatCost({ cost: 0.5, cost_status: null }) !== "$0.50") {
    throw new Error(formatCost({ cost: 0.5, cost_status: null }));
  }
  const html = formatCost({ cost: null, cost_status: null });
  if (!html.includes("Recorded before 0.5.1")) throw new Error(html);
});

test("formatCostTotal: all known, all unknown, and mixed", () => {
  if (formatCostTotal(totals({ cost: 1.23, knownCount: 3 })) !== "$1.23") {
    throw new Error(formatCostTotal(totals({ cost: 1.23, knownCount: 3 })));
  }
  const allUnknown = formatCostTotal(totals({ unknownCount: 4 }));
  if (allUnknown !== "4 reviews with unknown cost") {
    throw new Error(allUnknown);
  }
  const mixed = formatCostTotal(
    totals({ cost: 1.23, knownCount: 3, unknownCount: 4 }),
  );
  if (mixed !== "$1.23 · 4 reviews with unknown cost") throw new Error(mixed);
});

test("formatCostTotal: singular wording and no reviews at all", () => {
  const one = formatCostTotal(totals({ unknownCount: 1 }));
  if (one !== "1 review with unknown cost") throw new Error(one);
  if (formatCostTotal(totals()) !== "$0.00") {
    throw new Error(formatCostTotal(totals()));
  }
});

test("formatCostTotal: BYOK sits outside the main amount, never inside it", () => {
  const known = formatCostTotal(
    totals({ cost: 1, knownCount: 1, byokUsd: 4, byokKnownCount: 2 }),
  );
  if (known !== "$1.00 + $4.00 BYOK") throw new Error(known);
  const unknownByok = formatCostTotal(
    totals({ cost: 1, knownCount: 1, byokUnknownCount: 1 }),
  );
  if (unknownByok !== "$1.00 + 1 review with unknown cost BYOK") {
    throw new Error(unknownByok);
  }
});

test("totalOfRows folds a review list the same way the SQL aggregate does", () => {
  const totalsFromRows = totalOfRows([
    { cost: 0.01, cost_status: "known" },
    { cost: null, cost_status: "unknown" },
    { cost: 4, cost_status: "known", billed_to: "byok" },
    { cost: null, cost_status: "unknown", billed_to: "byok" },
  ]);
  if (
    totalsFromRows.cost !== 0.01 ||
    totalsFromRows.knownCount !== 1 ||
    totalsFromRows.unknownCount !== 1 ||
    totalsFromRows.byokUsd !== 4 ||
    totalsFromRows.byokKnownCount !== 1 ||
    totalsFromRows.byokUnknownCount !== 1
  ) {
    throw new Error(JSON.stringify(totalsFromRows));
  }
  if (formatCostTotal(totalOfRows([])) !== "$0.00") {
    throw new Error("an empty pull request has nothing to report");
  }
});
