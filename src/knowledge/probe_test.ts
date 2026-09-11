import { analyzeProbe } from "./probe.ts";
import type { Json } from "../types.ts";

const currentYear = new Date().getFullYear();

function pullsForYear(year: number, count: number): Json[] {
  return Array.from({ length: count }, (_, index) => ({
    number: `${year}-${index}`,
    updated_at: `${year}-06-01T00:00:00Z`,
  }));
}

Deno.test("probe prefers 24 recent months after a recent release", () => {
  const pulls = [
    ...pullsForYear(currentYear, 160),
    ...pullsForYear(currentYear - 1, 140),
    ...pullsForYear(currentYear - 2, 120),
    ...pullsForYear(currentYear - 3, 120),
    ...pullsForYear(currentYear - 4, 120),
    ...pullsForYear(currentYear - 5, 120),
  ];
  const result = analyzeProbe(
    {
      default_branch: "main",
      latest_release_at: `${currentYear - 1}-12-12T00:00:00Z`,
    },
    pulls,
    [],
    [],
  );
  if (result.maxPrMonths !== 24) {
    throw new Error(
      `expected a 24-month window, got ${result.maxPrMonths}`,
    );
  }
  if (!result.reasons.some((reason) => /recent/i.test(reason))) {
    throw new Error("probe did not explain the recent-release decision");
  }
});
