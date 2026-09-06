import { analyzeProbe } from "./probe.ts";
import type { Json } from "../types.ts";

const currentYear = new Date().getFullYear();

function pullsForYear(year: number, count: number): Json[] {
  return Array.from({ length: count }, (_, index) => ({
    number: `${year}-${index}`,
    updated_at: `${year}-06-01T00:00:00Z`,
  }));
}

Deno.test("probe prefers two recent years after a recent release", () => {
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
  if (result.maxPrYears !== 2) {
    throw new Error(`expected a two-year window, got ${result.maxPrYears}`);
  }
  if (!result.reasons.some((reason) => /recent/i.test(reason))) {
    throw new Error("probe did not explain the recent-release decision");
  }
});
