import type { Fact } from "./types.ts";

export type ReviewDocuments = {
  guide: string;
  detailed?: string;
};

/** A fact read out of a single pull request describes that request, not the
 * repository. `origin` is absent on facts written before the field existed, so
 * those count as repository policy (CORE-32 / F26b). */
export function isPullRequestFact(item: Fact): boolean {
  return item.origin === "pull-request";
}

function dedupe(items: Fact[]): Fact[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.claim.toLowerCase().replace(/\W+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reviewBarFacts(facts: Fact[]): Fact[] {
  return facts
    .filter(
      (item) =>
        item.sectionKey === "review-bar" &&
        item.evidence.some(
          (evidence) =>
            evidence.startsWith("PR #") ||
            evidence.startsWith("review discussion"),
        ),
    )
    .sort((a, b) => b.weight - a.weight || a.claim.localeCompare(b.claim));
}

/** The short guide's checklist: every recurring review signal, including the
 * ones mined from pull requests (CORE-32 keeps this file's PR source). */
function reviewFacts(facts: Fact[]): Fact[] {
  return dedupe(reviewBarFacts(facts));
}

/** The detailed guide's checklist: only expectations backed by repository-wide
 * evidence, never a single pull request's narrative (CORE-32). */
function detailedFacts(facts: Fact[]): Fact[] {
  return dedupe(
    reviewBarFacts(facts).filter((item) => !isPullRequestFact(item)),
  );
}

function detailedDocument(facts: Fact[]): string {
  const bullets = facts.flatMap((fact) => {
    const claim = fact.claim.replace(/\bPR\s*#?\s*\d+\b/gi, "the change");
    const lower = claim.toLowerCase();
    const category = lower.includes("test")
      ? "Missing or insufficient tests"
      : lower.includes("type")
        ? "Type and static validation"
        : lower.includes("documentation")
          ? "Missing documentation"
          : lower.includes("changelog")
            ? "Release-note completeness"
            : lower.includes("large") || lower.includes("focused")
              ? "Unfocused or risky scope"
              : "Repository-specific review expectation";
    return [
      `### ${category}`,
      `- Violation to avoid: ${claim}`,
      "- Inspect the affected implementation, nearby tests, and related workflow before requesting review.",
      "- Apply this check whenever a change touches the same behavior or integration boundary.",
    ];
  });
  return `# Detailed PR review guide

This file is a code-review checklist derived from recurring change requests.
Use it while inspecting the codebase and before opening a pull request.
It describes failure patterns to look for, not historical pull requests.

## Code-level checks

${bullets.join("\n")}
`;
}

/** The selected review signals, before the `>2` threshold is applied. Exported
 * so `init` can tell the user how far short of the threshold a repository is
 * (CORE-31), rather than silently skipping the two guide files. */
export function reviewSignalCount(facts: Fact[]): number {
  return reviewFacts(facts).length;
}

export function buildReviewDocuments(
  facts: Fact[],
): ReviewDocuments | undefined {
  const selected = reviewFacts(facts);
  if (selected.length <= 2) return undefined;

  const detailed = detailedDocument(detailedFacts(facts).slice(0, 120));
  const detailedLines = detailed.trimEnd().split("\n").length;
  if (detailedLines <= 100) {
    return {
      guide: `# PR review guide

Use this checklist before requesting review. These expectations occurred in
more than two selected pull-request review signals.

## Before requesting review

${selected.map((fact) => `- ${fact.claim}`).join("\n")}
`,
    };
  }

  return {
    guide: `# PR review guide

Use this file as the short checklist before requesting review. The detailed
code-level checks are in [PR_REVIEW_DETAILED_GUIDE.md](PR_REVIEW_DETAILED_GUIDE.md).

## Workflow

- Inspect the detailed checks that match the files and behavior being changed.
- Run the applicable tests and validation before requesting review.
- Treat the detailed checks as preventive guidance, not as a list of past PRs.
`,
    detailed,
  };
}
