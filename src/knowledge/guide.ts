import type { Fact } from "./types.ts";

export type ReviewDocuments = {
  guide: string;
  detailed?: string;
};

function reviewFacts(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  return facts
    .filter((item) =>
      item.sectionKey === "review-bar" &&
      item.evidence.some((evidence) =>
        evidence.startsWith("PR #") ||
        evidence.startsWith("review discussion")
      )
    )
    .sort((a, b) => b.weight - a.weight || a.claim.localeCompare(b.claim))
    .filter((item) => {
      const key = item.claim.toLowerCase().replace(/\W+/g, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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

export function buildReviewDocuments(
  facts: Fact[],
): ReviewDocuments | undefined {
  const selected = reviewFacts(facts);
  if (selected.length <= 2) return undefined;

  const detailed = detailedDocument(selected.slice(0, 120));
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
