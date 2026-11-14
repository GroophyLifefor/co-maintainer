import assert from "node:assert/strict";
import { test } from "node:test";
import { changedLines, pairProblems } from "./review_checks.ts";
import { PAIRS } from "./review_checks_repo.ts";
import {
  type CheckRun,
  classify,
  type ReviewInput,
  tagOf,
  touches,
  verdicts,
} from "./review_checks_score.ts";

const usage = { tokensIn: 0, tokensOut: 0, usd: 0, calls: 1 };
const at = (path: string, line: number, severity = "P2", body = "x") => ({
  path,
  lineFrom: line,
  lineTo: line,
  severity,
  title: "t",
  body,
});

function review(patch: Partial<ReviewInput>): ReviewInput {
  return {
    change: "c3-seeded",
    kind: "seeded",
    check: "C3",
    arm: "checks",
    finished: true,
    findings: [],
    spans: [{ path: "src/a.ts", from: 10, to: 12 }],
    usage,
    ...patch,
  };
}

test("a tag is a check id in brackets at the start of the body, else of the title", () => {
  assert.equal(tagOf({ body: "[C3] the reader", title: "x" }), "C3");
  assert.equal(tagOf({ body: "  [C7] moved code", title: "x" }), "C7");
  assert.equal(tagOf({ body: "plain", title: "[C2] odd one" }), "C2");
  assert.equal(tagOf({ body: "see [C3]", title: "x" }), null);
  assert.equal(tagOf({ body: "[C8] none", title: "x" }), null);
});

test("a finding touches a span within three lines either side, in the same file", () => {
  const span = { path: "src/a.ts", from: 10, to: 12 };
  assert.ok(touches(at("src/a.ts", 7), span));
  assert.ok(touches(at("src/a.ts", 15), span));
  assert.ok(!touches(at("src/a.ts", 6), span));
  assert.ok(!touches(at("src/a.ts", 16), span));
  assert.ok(!touches(at("src/b.ts", 11), span));
  assert.ok(touches({ path: "src/a.ts", lineFrom: 1, lineTo: 40 }, span));
});

test("on a seeded change: a catch at P0 to P2, P3 only for C7, the rest is other", () => {
  const found = classify(
    review({
      findings: [
        at("src/a.ts", 11, "P1", "[C3] reader"),
        at("src/a.ts", 11, "P3"),
        at("src/a.ts", 40, "P1"),
      ],
    }),
  );
  assert.deepEqual(
    found.map((item) => [item.class, item.tag, item.lowAtSeed ?? false]),
    [
      ["catch", "C3", false],
      ["other", null, true],
      ["other", null, false],
    ],
  );
  const seven = classify(
    review({ check: "C7", findings: [at("src/a.ts", 11, "P3", "[C7] moved")] }),
  );
  assert.equal(seven[0]!.class, "catch");
});

test("on a twin or a clean change every P0 to P2 is false and a P3 is apart", () => {
  const found = classify(
    review({
      kind: "fixed",
      findings: [at("src/a.ts", 11, "P2", "[C3] x"), at("src/a.ts", 11, "P3")],
    }),
  );
  assert.deepEqual(
    found.map((item) => item.class),
    ["false", "p3"],
  );
});

const row = (patch: Partial<CheckRun>): CheckRun => ({
  check: "C1",
  baselineCatches: 0,
  checksCatches: 0,
  falseWithTag: 0,
  taggedCatches: 0,
  ...patch,
});

test("the pass rule: one catch the baseline missed, and at most one tagged false finding per run", () => {
  const pass = verdicts([
    [row({ checksCatches: 1 })],
    [row({ checksCatches: 1, baselineCatches: 1, falseWithTag: 2 })],
    [row({ falseWithTag: 1 })],
  ]).find((item) => item.check === "C1")!;
  assert.deepEqual(
    [
      pass.pass,
      pass.runs,
      pass.gains,
      pass.checksCaught,
      pass.baselineCaught,
      pass.falseWithTagMean,
    ],
    [true, 3, 1, 2, 1, 1],
  );
  const noisy = verdicts([
    [row({ checksCatches: 1, falseWithTag: 2 })],
    [row({ falseWithTag: 1 })],
  ]).find((item) => item.check === "C1")!;
  assert.equal(noisy.pass, false);
  const noGain = verdicts([
    [row({ checksCatches: 1, baselineCatches: 1 })],
  ]).find((item) => item.check === "C1")!;
  assert.equal(noGain.pass, false);
  const unseen = verdicts([]).find((item) => item.check === "C1")!;
  assert.deepEqual([unseen.pass, unseen.runs], [false, 0]);
});

test("changed lines counts the larger side of a line diff", () => {
  assert.equal(changedLines("a\nb\nc", "a\nb\nc"), 0);
  assert.equal(changedLines("a\nb\nc", "a\nx\nc"), 1);
  assert.equal(changedLines("a\nc", "a\nx\ny\nc"), 2);
});

test("every pair differs only where it says, and a pair that differs more fails", () => {
  assert.deepEqual(PAIRS.flatMap(pairProblems), []);
  const c3 = PAIRS.find((pair) => pair.check === "C3")!;
  const widened = {
    ...c3,
    fixed: {
      ...c3.fixed,
      files: {
        "src/sessions/ingest.ts": `${c3.fixed.files["src/sessions/ingest.ts"]}// extra\n`,
      },
    },
  };
  assert.match(pairProblems(widened).join(), /3 lines differ, 2 declared/);
  const moved = {
    ...c3,
    spans: [{ path: "src/sessions/ingest.ts", from: "nowhere" }],
  };
  assert.match(pairProblems(moved).join(), /no line holds nowhere/);
});
