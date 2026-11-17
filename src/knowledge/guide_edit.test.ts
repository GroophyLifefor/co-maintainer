import { test } from "node:test";
import {
  applyGuideEdits,
  GuideEditError,
  guideRuleIds,
  keptSources,
  parseGuideEdits,
} from "./guide_edit.ts";
import { assignGuideIds } from "./guide_ids.ts";
import type { RuleEntry } from "./rules.ts";

const DETAILED = `# Review method

How to review a change here.

## Data

**Goal:** keep data right.

- Scope every read to one tenant · a whole scan costs per request [R1]
  - the orders list read every tenant
- Add an index for a new array predicate · containment cannot use a btree [R2]
  - tags[] filter

**Exit check:**
- \`src/db/*\` → reads are scoped

## Shutdown

**Goal:** lose nothing.

- Drain writes before shutdown · a dropped write is lost [R3]
  - the worker exited mid-batch

**Exit check:**
- \`src/worker.ts\` → drains first
`;

const RULES: Record<string, RuleEntry> = {
  R1: { file: "x", text: "a", sources: [{ pr: 10 }] },
  R2: { file: "x", text: "b", sources: [{ pr: 11, url: "https://x/11#r" }] },
  R3: { file: "x", text: "c", sources: [{ pr: 12 }] },
};

test("an unusable edit answer is refused, never half applied", () => {
  for (const text of [
    "",
    "not json",
    '{"add": "x"}',
    '{"change": [{"id": 3}]}',
  ]) {
    if (parseGuideEdits(text) !== null) throw new Error(`accepted: ${text}`);
  }
  const fenced = parseGuideEdits('```json\n{"remove": ["R2"]}\n```');
  if (fenced?.remove[0] !== "R2") throw new Error(JSON.stringify(fenced));
});

test("an edit adds, changes and removes rules and leaves every other line as it was", () => {
  const ids = guideRuleIds(DETAILED);
  if (ids.join(",") !== "R1,R2,R3") throw new Error(ids.join(","));
  const kept = keptSources(ids, RULES, 5);
  const edited = applyGuideEdits(
    DETAILED,
    {
      add: [
        {
          pass: "shutdown",
          rule: "Close queues before exit · a queued job is lost [4]",
          example: "the mailer queue",
        },
      ],
      change: [
        {
          id: "R1",
          rule: "Scope every read and write to one tenant · a whole scan costs per request [5]",
        },
      ],
      remove: ["R2"],
    },
    kept.pseudo,
    5,
    true,
  );
  const want = DETAILED.replace(
    "- Scope every read to one tenant · a whole scan costs per request [R1]",
    "- Scope every read and write to one tenant · a whole scan costs per request [5, 6]",
  )
    .replace(
      "- Add an index for a new array predicate · containment cannot use a btree [R2]\n  - tags[] filter\n",
      "",
    )
    .replace(
      "- Drain writes before shutdown · a dropped write is lost [R3]\n  - the worker exited mid-batch\n",
      "- Drain writes before shutdown · a dropped write is lost [8]\n  - the worker exited mid-batch\n- Close queues before exit · a queued job is lost [4]\n  - the mailer queue\n",
    );
  if (edited !== want) throw new Error(`edited:\n${edited}`);
  // The pseudo numbers carry the kept rules' sources into the id pipeline.
  if (kept.pullRequests.join("|") !== "10|11|12") {
    throw new Error(kept.pullRequests.join("|"));
  }
  if (kept.links[1]?.[0]?.url !== "https://x/11#r") {
    throw new Error(JSON.stringify(kept.links));
  }
  const assigned = assignGuideIds(edited, undefined, 8);
  if (assigned.rules.length !== 3) {
    throw new Error(`${assigned.rules.length} rules after the edit`);
  }
});

test("an edit that names a rule or a pass the guide does not have is refused", () => {
  const kept = keptSources(guideRuleIds(DETAILED), RULES, 5);
  for (const edits of [
    { add: [], change: [{ id: "R9", rule: "x · y [1]" }], remove: [] },
    { add: [], change: [], remove: ["R7"] },
    { add: [{ pass: "Nowhere", rule: "x · y [1]" }], change: [], remove: [] },
    {
      add: [{ pass: "Data", rule: "no sources · here" }],
      change: [],
      remove: [],
    },
  ]) {
    let refused = false;
    try {
      applyGuideEdits(DETAILED, edits, kept.pseudo, 5, true);
    } catch (error) {
      refused = error instanceof GuideEditError;
    }
    if (!refused) throw new Error(`accepted: ${JSON.stringify(edits)}`);
  }
});

test("no edits relabels the guide and changes no word", () => {
  const kept = keptSources(guideRuleIds(DETAILED), RULES, 5);
  const same = applyGuideEdits(
    DETAILED,
    { add: [], change: [], remove: [] },
    kept.pseudo,
    5,
    true,
  );
  if (
    same !==
    DETAILED.replace("[R1]", "[6]")
      .replace("[R2]", "[7]")
      .replace("[R3]", "[8]")
  ) {
    throw new Error(same);
  }
});
