import { test } from "node:test";
import assert from "node:assert/strict";
import { renameIdsInMarkdown, stableIds } from "./stable_ids.ts";
import type { RuleEntry } from "./rules.ts";

function rule(text: string, prs: number[]): RuleEntry {
  return {
    file: "PR_REVIEW_GUIDE.md",
    text,
    sources: prs.map((pr) => ({ pr })),
  };
}

test("a rewritten rule keeps its id, a new one gets the next number, a dropped id is not given again", () => {
  const previous = {
    R1: rule("Percentages round half down", [212]),
    R2: rule("Every route checks auth", [98]),
    R3: rule("Old habit", [10]),
  };
  const { ids, lastId } = stableIds(
    "R",
    [
      {
        id: "R1",
        text: "Every route checks auth first",
        sources: [{ pr: 98 }],
      },
      {
        id: "R2",
        text: "Percentages round half up",
        sources: [{ pr: 212 }, { pr: 340 }],
      },
      { id: "R3", text: "A brand new rule", sources: [{ pr: 400 }] },
    ],
    previous,
    5,
  );
  assert.equal(ids.get("R1"), "R2");
  assert.equal(ids.get("R2"), "R1");
  // R3 dropped, and 4 and 5 were given before: the new rule is R6.
  assert.equal(ids.get("R3"), "R6");
  assert.equal(lastId, 6);
});

test("a rule never takes the id of the rule it overturns", () => {
  const { ids } = stableIds(
    "R",
    [
      {
        id: "R1",
        text: "Round half up",
        sources: [{ pr: 212 }],
        avoid: ["R4"],
      },
    ],
    { R4: rule("Round half down", [212]) },
    undefined,
  );
  assert.equal(ids.get("R1"), "R5");
});

test("an instruction line that moved keeps its id by text", () => {
  const { ids } = stableIds(
    "I",
    [
      {
        id: "I1",
        text: "Use pnpm",
        sources: [{ path: "AGENTS.md", line: 20 }],
      },
    ],
    {
      I3: {
        file: "INSTRUCTIONS.md",
        text: "Use pnpm",
        sources: [{ path: "AGENTS.md", line: 14 }],
      },
    },
    undefined,
  );
  assert.equal(ids.get("I1"), "I3");
});

test("renaming ids in one pass never collides", () => {
  const markdown = "- a · why [R1]\n- b · why [R2]\n- `[R1]` in code stays\n";
  const out = renameIdsInMarkdown(
    markdown,
    new Map([
      ["R1", "R2"],
      ["R2", "R5"],
    ]),
  );
  assert.equal(out, "- a · why [R2]\n- b · why [R5]\n- `[R1]` in code stays\n");
});

test("a rule that could keep two ids gives way to a later rule that can keep only one", () => {
  const { ids, lastId } = stableIds(
    "R",
    [
      { id: "R1", text: "A", sources: [{ pr: 1 }, { pr: 2 }] },
      { id: "R2", text: "B", sources: [{ pr: 1 }] },
    ],
    { R1: rule("old one", [1]), R2: rule("old two", [2]) },
    2,
  );
  assert.equal(ids.get("R1"), "R2");
  assert.equal(ids.get("R2"), "R1");
  assert.equal(lastId, 2);
});

// The case a real sync of a small repository hit: two rules rest only on
// pull request 4, and the rebuilt guide listed them in the other order.
const MULTIPLIER =
  "When duration-unit mappings change, every multiplier must use the parser’s millisecond base unit and agree with formatting · mixing seconds and milliseconds silently changes duration magnitudes";
const RANGE_ERROR =
  "When parse changes, invalid or unsupported values must raise RangeError · generic errors break the established error-type convention for invalid parse values";

test("two rules on the same pull request keep their ids by wording when there are no links", () => {
  const { ids } = stableIds(
    "R",
    [
      {
        id: "R1",
        text: "When duration-unit mappings change, every multiplier must use the parser’s millisecond base unit and agree with formatting · a seconds-based multiplier silently changes the magnitude of parsed durations",
        sources: [
          { pr: 4, url: "https://github.com/o/r/pull/4#discussion_r3" },
        ],
      },
      {
        id: "R2",
        text: "When parse rejects an invalid or unparsable duration, it must throw RangeError consistently · a generic error breaks the parser’s established error-type convention",
        sources: [
          { pr: 4, url: "https://github.com/o/r/pull/4#discussion_r10" },
        ],
      },
    ],
    { R2: rule(MULTIPLIER, [4]), R3: rule(RANGE_ERROR, [4]) },
    5,
  );
  // The multiplier rule comes first now. Matched by pull request alone it
  // took R3 and pushed the RangeError rule onto R2.
  assert.equal(ids.get("R1"), "R2");
  assert.equal(ids.get("R2"), "R3");
});

test("two rules on the same pull request keep their ids by comment link, whatever the wording", () => {
  const linked = (text: string, url: string): RuleEntry => ({
    file: "PR_REVIEW_GUIDE.md",
    text,
    sources: [{ pr: 4, url }],
  });
  const { ids } = stableIds(
    "R",
    [
      {
        id: "R1",
        text: "Completely reworded first rule",
        sources: [
          { pr: 4, url: "https://github.com/o/r/pull/4#discussion_r3" },
        ],
      },
      {
        id: "R2",
        text: "Completely reworded second rule",
        sources: [
          { pr: 4, url: "https://github.com/o/r/pull/4#discussion_r10" },
        ],
      },
    ],
    {
      R2: linked(MULTIPLIER, "https://github.com/o/r/pull/4#discussion_r3"),
      R3: linked(RANGE_ERROR, "https://github.com/o/r/pull/4#discussion_r10"),
    },
    5,
  );
  assert.equal(ids.get("R1"), "R2");
  assert.equal(ids.get("R2"), "R3");
});
