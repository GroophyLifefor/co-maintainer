/** How many tool rounds a review may take. Bigger own-scope diffs need more
 * codegraph round trips to trace, so the count grows with the diff and stops
 * at 8. Kept apart from the reviewer so the probe estimate can use it
 * without loading the review. Uncapped, a 100,000-line diff would ask for
 * 1,000+ rounds, each able to spend multiple external calls. */
export function clampToolRounds(totalDiffLines: number): number {
  return Math.min(Math.round(4 + totalDiffLines / 100), 8);
}
