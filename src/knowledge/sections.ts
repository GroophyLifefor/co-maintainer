export const sectionTitles: Record<string, string> = {
  identity: "Repository",
  devloop: "Development and debugging",
  ship: "Shipping",
  layout: "Code layout",
  style: "Code style",
  tests: "Tests",
  "title-body": "Pull request title and body",
  labels: "Labels",
  "review-bar": "Review bar",
  process: "Pull request process",
};

export const sectionKeys = Object.keys(sectionTitles);

/** Sections whose content also lives in `CODEBASE.md`. The skill links to that
 * file instead of keeping a second copy (CORE-32 / F26c). */
export const codebaseSectionKeys = new Set([
  "layout",
  "style",
  "tests",
  "devloop",
]);

/** A fact read out of a single pull request describes that request, not the
 * repository, so it may only feed the `review-bar` checklist. Every other
 * section states repository policy and must not learn from one PR's narrative
 * (CORE-32 / F26b). Keep this in sync with `guide.ts`, which applies the same
 * rule to the review guides. */
export function sectionAllowsPrFacts(key: string): boolean {
  return key === "review-bar";
}
