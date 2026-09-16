import { reviewExitCode } from "./review_output.ts";

Deno.test("reviewExitCode: non-blocking P2 exits 0", () => {
  const md = `## Findings

### [P2 · non-blocking] \`src/a.ts\` — \`fn()\`
Location: \`src/a.ts:1\`

Issue here.
`;
  if (reviewExitCode(md) !== 0) {
    throw new Error("non-blocking should exit 0");
  }
});

Deno.test("reviewExitCode: blocking P1 exits 1", () => {
  const md = `## Findings

### [P1 · blocking] \`src/a.ts\` — \`fn()\`
Location: \`src/a.ts:1\`

Issue here.
`;
  if (reviewExitCode(md) !== 1) {
    throw new Error("blocking should exit 1");
  }
});
