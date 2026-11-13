import { test } from "node:test";
import { assignGuideIds, guideWriteLine } from "./guide_ids.ts";

const SINGLE = `# Review method

How to review a change here.

## Call sites

**Goal:** keep callers correct.

- Update every caller of a changed symbol · a stale caller keeps the old behavior [3, 1]
  - The \`items[0]\` read in \`src/app.ts\` was missed [2]
- Never read items[3] directly · it skips the bounds check [5]
- Keep the tuple [0, 1] normalized · callers compare it by value [2]
- Pin the regression with a test · CI stays green otherwise
- Keep error bodies shape-stable · a 400 turned into a 500 [99]
- Mark docs-only commits · see footnote [1] [4]
- Skip CI only for docs · tag the commit [skip ci]
  - config[2] in src/a.ts was read twice

See footnote [1].

**Exit check:** keep args[0] as the path → every caller updated [1]
`;

test("only a bracket at the end of a check line is a source list, every other bracket stays", () => {
  const result = assignGuideIds(SINGLE, undefined, 5);
  const want = `# Review method

How to review a change here.

## Call sites

**Goal:** keep callers correct.

- Update every caller of a changed symbol · a stale caller keeps the old behavior [R1]
  - The \`items[0]\` read in \`src/app.ts\` was missed [2]
- Never read items[3] directly · it skips the bounds check [R2]
- Keep the tuple [0, 1] normalized · callers compare it by value [R3]
- Pin the regression with a test · CI stays green otherwise
- Keep error bodies shape-stable · a 400 turned into a 500
- Mark docs-only commits · see footnote [1] [R4]
- Skip CI only for docs · tag the commit [skip ci]
  - config[2] in src/a.ts was read twice

See footnote [1].

**Exit check:** keep args[0] as the path → every caller updated [1]
`;
  if (result.guide !== want) {
    throw new Error(`guide:\n${result.guide}`);
  }
  const sources = result.rules.map(
    (rule) => `${rule.id}=${rule.findings.join(",")}`,
  );
  if (sources.join(" ") !== "R1=1,3 R2=5 R3=2 R4=4") {
    throw new Error(`sources: ${sources.join(" ")}`);
  }
  if (
    result.rules[1].text !==
    "Never read items[3] directly · it skips the bounds check"
  ) {
    throw new Error(`text: ${result.rules[1].text}`);
  }
  if (
    guideWriteLine(result.counts[0]) !==
    "PR_REVIEW_GUIDE.md · 7 rules · 4 with sources"
  ) {
    throw new Error(`count: ${guideWriteLine(result.counts[0])}`);
  }
});

test("a source list inside inline code is code, not a source list", () => {
  const guide =
    "# G\n\n## A\n\n- Call it as `f [1]` · it breaks [2]\n- Write `g [3]` · it fails\n";
  const result = assignGuideIds(guide, undefined, 5);
  if (
    result.guide !==
    "# G\n\n## A\n\n- Call it as `f [1]` · it breaks [R1]\n- Write `g [3]` · it fails\n"
  ) {
    throw new Error(`guide:\n${result.guide}`);
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
