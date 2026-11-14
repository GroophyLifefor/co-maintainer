/** The fixed input for the guide prompt pin test: three review findings and
 * a method long enough to make the short guide request too. */
import type { Fact } from "../../knowledge/types.ts";

function finding(claim: string, extra: Partial<Fact> = {}): Fact {
  return {
    id: `review:${claim}`,
    sectionKey: "review",
    claim,
    evidence: ["PR #12"],
    weight: 1,
    scope: "historical-example",
    confidence: "medium",
    status: "active",
    origin: "pull-request",
    impact: "it can regress",
    action: "check it",
    ...extra,
  };
}

export const PIN_FACTS: Fact[] = [
  finding("Require a test for a behavior change.", {
    class: "tests",
    trigger: "src/**",
    evidence: ["PR #12", "PR #40"],
    weight: 3,
  }),
  finding("Add the MCP tool for a new route.", {
    class: "api",
    location: "src/routes.ts:10",
  }),
  finding("Add an index for a new array predicate.", { class: "data" }),
];

export const PIN_LONG_GUIDE = `# Review method

How to review a change here.

${["Call sites", "Data cost", "Tests"]
  .map(
    (area) => `## ${area}

**Goal:** keep this area correct.
**Applies to:** related changes.

${Array.from({ length: 10 }, (_, index) => `- Check ${area} behavior ${index} · it can regress`).join("\n")}

**Exit check:** the area is satisfied.`,
  )
  .join("\n\n")}
`;
