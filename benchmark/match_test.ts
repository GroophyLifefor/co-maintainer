import { matchSpans, overlaps } from "./match.ts";
import { scores } from "./metrics.ts";
import { parseFindings } from "../src/pr/findings.ts";

Deno.test("line ranges on the same path overlap", () => {
  if (
    !overlaps(
      { path: "src/a.js", from: 10, to: 12 },
      { path: "./src/a.js", from: 12, to: 20 },
    )
  ) {
    throw new Error("expected overlap");
  }
});

Deno.test("greedy matching scores a true positive and a false positive", () => {
  const counts = matchSpans(
    [
      { path: "src/a.js", from: 10, to: 10 },
      { path: "src/b.js", from: 1, to: 1 },
    ],
    [{ path: "src/a.js", from: 8, to: 12 }],
  );
  if (counts.tp !== 1 || counts.fp !== 1 || counts.fn !== 0) {
    throw new Error(JSON.stringify(counts));
  }
  const { f1, precision, recall } = scores(counts);
  if (precision !== 0.5 || recall !== 1 || f1 !== 2 / 3) {
    throw new Error(JSON.stringify({ f1, precision, recall }));
  }
});

Deno.test("parseFindings reads file:line from markdown findings", () => {
  const found = parseFindings(`## Severity

- P0 — Critical

## Findings

### P2 — JSDoc type is wrong

\`src/nodes/gpgpu/ComputeNode.js:222\`

The parameter can be a number or an array.
`);
  if (
    found.length !== 1 ||
    found[0].path !== "src/nodes/gpgpu/ComputeNode.js" ||
    found[0].from !== 222
  ) {
    throw new Error(JSON.stringify(found));
  }
});

Deno.test("parseFindings collects every file:line in findings", () => {
  const found = parseFindings(`## Findings

### [P1] First

**File:** \`src/a.js:10\`

### [P2] Second

**File:** \`src/b.js:20-22\`
`);
  if (found.length !== 2 || found[1].from !== 20 || found[1].to !== 22) {
    throw new Error(JSON.stringify(found));
  }
});

Deno.test("parseFindings accepts a file at the repository root", () => {
  const found = parseFindings(`## Findings

### P0 eval of untrusted input

e2e-seed.ts:2

Do not pass untrusted input to eval.
`);
  if (
    found.length !== 1 ||
    found[0].path !== "e2e-seed.ts" ||
    found[0].from !== 2
  ) {
    throw new Error(JSON.stringify(found));
  }
});
