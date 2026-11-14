/** The local review flow: its fake reviewer's readers, the flow itself, and a
 * small feature flow built only from what the module exports. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { check, defineFlow, type Printer, runFlow } from "../flow.ts";
import localFlow, {
  carryEntries,
  checkoutStep,
  editStep,
  humanGroups,
  LOCAL_BASE_AI,
  LOCAL_CHANGE,
  LOCAL_SMELLS,
  localState,
  NO_CODEGRAPH,
  prepareLocalRepo,
  promptDiff,
  reviewChat,
  reviewerReply,
  reviewStep,
  STATS_CLEAN,
  summaryOf,
} from "./local.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };
const settings = () => ({
  mode: "fake" as const,
  provider: "openrouter" as const,
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

const PROMPT = [
  "intro",
  "PREVIOUS FINDINGS (this run has two separate jobs):",
  "VERIFY:",
  "F1 · could not locate · src/a.ts:4-5",
  "The helper ignores its argument",
  "",
  "F2 · still present in changed code · src/b.ts:7",
  "Another finding",
  "",
  "WORKSPACE:",
  '{"branch":"origin/main","changedFiles":["src/b.ts"]}',
  "",
  "DIFF:",
  "FILE: src/b.ts",
  "@@ -1,2 +1,3 @@",
  "     1  keep",
  "       -old",
  "     2 +const a = 1;",
  '     3 +console.log("describing")',
  "",
  "UNCHANGED SINCE LAST REVIEW (paths only):",
  "- src/a.ts",
].join("\n");

test("promptDiff reads added lines by file and stops before the unchanged list", () => {
  const diff = promptDiff(PROMPT);
  assert.deepEqual([...diff.keys()], ["src/b.ts"]);
  assert.equal(diff.get("src/b.ts")!.get(2), "const a = 1;");
  assert.equal(diff.get("src/b.ts")!.has(1), false);
});

test("carryEntries reads the label, hint and span of each entry", () => {
  assert.deepEqual(carryEntries(PROMPT), [
    {
      label: "F1",
      hint: "could not locate",
      path: "src/a.ts",
      from: 4,
      to: 5,
    },
    {
      label: "F2",
      hint: "still present in changed code",
      path: "src/b.ts",
      from: 7,
      to: 7,
    },
  ]);
  assert.deepEqual(carryEntries("no carry section"), []);
});

test("the reviewer closes what the product could not locate and follows a moved line", () => {
  const smells = [
    ...LOCAL_SMELLS,
    {
      path: "src/b.ts",
      marker: "console.log(",
      finding: () => ({}),
    },
  ];
  const reply = reviewerReply(smells, {
    prompt: PROMPT,
    round: 0,
    body: {},
  }) as { json: { findings: unknown[]; previousFindings: unknown[] } };
  assert.deepEqual(reply.json.previousFindings, [
    { id: "F1", state: "closed" },
    {
      id: "F2",
      state: "open",
      path: "src/b.ts",
      lineFrom: 3,
      lineTo: 3,
    },
  ]);
  // A finding a carried one already covers is not reported again.
  assert.deepEqual(reply.json.findings, []);
});

test("humanGroups lists the locations of each group", () => {
  const text = [
    "title",
    "",
    "Closed (1)",
    "  ✓ src/a.ts:9  [P2 · non-blocking]",
    "",
    "Still open (1)",
    "  • src/b.ts:4  [P1 · blocking] `x`",
    "    body line",
    "",
    "Summary: 0 new",
  ].join("\n");
  assert.deepEqual(humanGroups(text), {
    Closed: ["src/a.ts:9"],
    "Still open": ["src/b.ts:4"],
  });
});

test("the local flow passes every step and check", async () => {
  const result = await runFlow(localFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((item) => !item.ok && item.skipped === undefined),
  ];
  assert.deepEqual(failed, []);
});

// What a feature flow looks like: the repository, the change, two rounds.
const example = defineFlow({
  name: "local-example",
  description: "a feature flow built from the local flow's exports",
  ai: LOCAL_BASE_AI,
  steps: [
    { name: "repository with guides", run: (sim) => prepareLocalRepo(sim) },
    checkoutStep("main", LOCAL_CHANGE),
    reviewStep("round 1", "main", ["--json", NO_CODEGRAPH]),
    editStep("author removes the debug line", "main", {
      "src/stats.ts": STATS_CLEAN,
    }),
    reviewStep("round 2", "main", ["--json", NO_CODEGRAPH]),
  ],
  checks: (sim) => {
    const round2 = localState(sim).runs.get("round 2")!;
    return [
      check(
        "round 2 closes the removed finding",
        summaryOf(round2).closed === 1 && summaryOf(round2).open === 1,
        JSON.stringify(summaryOf(round2)),
      ),
      check(
        "round 2 asked the model once, in one conversation",
        reviewChat(round2).length === 1,
        `${reviewChat(round2).length} requests`,
      ),
    ];
  },
});

test("a feature flow built from the exports runs and passes", async () => {
  const result = await runFlow(example, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((item) => !item.ok && item.skipped === undefined),
  ];
  assert.deepEqual(failed, []);
});
