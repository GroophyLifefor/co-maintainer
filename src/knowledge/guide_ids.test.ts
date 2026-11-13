import { test } from "node:test";
import { assignGuideIds, guideWriteLine } from "./guide_ids.ts";

const SINGLE = `# Review method

How to review a change here.

## Call sites

**Goal:** keep callers correct.

- Update every caller of a changed symbol · a stale caller keeps the old behavior [3, 1]
  - The \`items[0]\` read in \`src/app.ts\` was missed [2]
- Pin the regression with a test · CI stays green otherwise
- Keep error bodies shape-stable · a 400 turned into a 500 [99]

**Exit check:** \`src/app.ts\` → every caller updated [1]
`;

test("a check line's bracket becomes an R id in file order, and other brackets go", () => {
  const result = assignGuideIds(SINGLE, undefined, 5);
  if (
    !result.guide.includes(
      "- Update every caller of a changed symbol · a stale caller keeps the old behavior [R1]",
    )
  ) {
    throw new Error(`no id:\n${result.guide}`);
  }
  if (
    !result.guide.includes(
      "  - The `items[0]` read in `src/app.ts` was missed\n",
    )
  ) {
    throw new Error(
      `the example line kept its bracket or lost its code:\n${result.guide}`,
    );
  }
  if (
    !result.guide.includes(
      "- Pin the regression with a test · CI stays green otherwise\n",
    )
  ) {
    throw new Error("a line with no bracket changed");
  }
  if (
    !result.guide.includes(
      "- Keep error bodies shape-stable · a 400 turned into a 500\n",
    )
  ) {
    throw new Error("an out-of-range bracket was kept or got an id");
  }
  if (
    !result.guide.includes(
      "**Exit check:** `src/app.ts` → every caller updated\n",
    )
  ) {
    throw new Error("the exit check kept its bracket");
  }
  if (result.rules.length !== 1) {
    throw new Error(`rules: ${JSON.stringify(result.rules)}`);
  }
  const rule = result.rules[0];
  if (
    rule.id !== "R1" ||
    rule.file !== "PR_REVIEW_GUIDE.md" ||
    rule.findings.join(",") !== "1,3" ||
    rule.text !==
      "Update every caller of a changed symbol · a stale caller keeps the old behavior"
  ) {
    throw new Error(`rule: ${JSON.stringify(rule)}`);
  }
  if (
    guideWriteLine(result.counts[0]) !==
    "PR_REVIEW_GUIDE.md · 3 rules · 1 with sources"
  ) {
    throw new Error(`count: ${guideWriteLine(result.counts[0])}`);
  }
});

test("a short-guide line with a detailed line's finding set shares its id", () => {
  const detailed = `# Full method

## Data

- Scope every read to one tenant · a whole scan costs per request [4]
- Add an index for a new array predicate · containment cannot use a btree [2, 5]
- Drain writes before shutdown · a dropped write is lost [1]
`;
  const short = `# Checklist

See [PR_REVIEW_DETAILED_GUIDE.md](PR_REVIEW_DETAILED_GUIDE.md) for the full method.

## Data

- Index new array predicates · btree cannot serve them [5, 2]
- Scope reads and drain writes · both cost on every request [1, 4]
`;
  const result = assignGuideIds(short, detailed, 5);
  if (!result.detailed?.includes("containment cannot use a btree [R2]")) {
    throw new Error(`detailed:\n${result.detailed}`);
  }
  if (!result.guide.includes("btree cannot serve them [R2]")) {
    throw new Error(`the short line did not share R2:\n${result.guide}`);
  }
  if (!result.guide.includes("both cost on every request [R4]")) {
    throw new Error(
      `a merged short line did not get a new id:\n${result.guide}`,
    );
  }
  const ids = result.rules.map((rule) => `${rule.id}:${rule.file}`);
  if (
    ids.join(",") !==
    "R1:PR_REVIEW_DETAILED_GUIDE.md,R2:PR_REVIEW_DETAILED_GUIDE.md,R3:PR_REVIEW_DETAILED_GUIDE.md,R4:PR_REVIEW_GUIDE.md"
  ) {
    throw new Error(`ids: ${ids.join(",")}`);
  }
  if (
    !result.guide.includes(
      "[PR_REVIEW_DETAILED_GUIDE.md](PR_REVIEW_DETAILED_GUIDE.md)",
    )
  ) {
    throw new Error("the link to the detailed guide was touched");
  }
  const counts = result.counts.map(guideWriteLine);
  if (
    counts.join(" | ") !==
    "PR_REVIEW_GUIDE.md · 2 rules · 2 with sources | PR_REVIEW_DETAILED_GUIDE.md · 3 rules · 3 with sources"
  ) {
    throw new Error(`counts: ${counts.join(" | ")}`);
  }
});
