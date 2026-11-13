/** A review's total cost includes its extensions. The review's own cost is
 * the total minus the extensions, and each extension's cost comes from the
 * `usage` it reported. */
import type { CostTally } from "../util/cost.ts";
import { extensionsCostUsd, type ExtensionReport } from "./report.ts";

/** Adds the extensions' reported cost to a review's tally. It adds no AI
 * call, so an AI cost that is unknown keeps the total unknown. */
export function addExtensionCost(
  tally: CostTally,
  report: ExtensionReport,
): void {
  tally.cost += extensionsCostUsd(report);
}
