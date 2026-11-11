import { judgeVerdicts } from "./init.ts";
import { test } from "node:test";

const answer = (verdicts: unknown) => JSON.stringify({ verdicts });

test("judgeVerdicts: a claim is counted once, the first verdict wins", () => {
  const verdicts = judgeVerdicts(
    answer([
      { n: 1, supported: true },
      { n: 1, supported: false },
    ]),
    1,
  );
  if (verdicts.length !== 1 || !verdicts[0]!.supported) {
    throw new Error(`expected one supported verdict, got ${verdicts.length}`);
  }
});

test("judgeVerdicts: claim numbers outside the list are dropped", () => {
  const verdicts = judgeVerdicts(
    answer([
      { n: 0, supported: true },
      { n: 3, supported: true },
      { n: 1.5, supported: true },
      { n: "2", supported: true },
      { n: 2, supported: true },
    ]),
    2,
  );
  if (verdicts.length !== 1 || verdicts[0]!.n !== 2) {
    throw new Error(`expected only claim 2, got ${JSON.stringify(verdicts)}`);
  }
});

test("judgeVerdicts: supported must be a boolean", () => {
  const verdicts = judgeVerdicts(
    answer([
      { n: 1, supported: "yes" },
      { n: 2, supported: 1 },
    ]),
    2,
  );
  if (verdicts.length !== 0) throw new Error("truthy values were counted");
});

test("judgeVerdicts: no JSON or no verdict list gives no verdicts", () => {
  if (judgeVerdicts("not json", 2).length !== 0) throw new Error("not json");
  if (judgeVerdicts(answer({ n: 1 }), 2).length !== 0) {
    throw new Error("verdicts that are not a list");
  }
});
