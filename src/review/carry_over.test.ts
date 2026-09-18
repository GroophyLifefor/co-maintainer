import {
  findingsMarkdownForParse,
  parsePreviousVerdicts,
} from "./carry_over.ts";
import { test } from "node:test";

test("carry_over: parse previous verdict lines", () => {
  const text = `## Findings
- something

## Previous findings
- F1: closed
- F2: open src/app.ts:4-6
`;
  const verdicts = parsePreviousVerdicts(text);
  if (verdicts.length !== 2 || verdicts[0].state !== "closed") {
    throw new Error(JSON.stringify(verdicts));
  }
  if (verdicts[1].path !== "src/app.ts" || verdicts[1].from !== 4) {
    throw new Error(JSON.stringify(verdicts[1]));
  }
});

test("carry_over: strip previous findings before parse", () => {
  const md = "## Findings\n- [P2] bug\n\n## Previous findings\n- F1: closed\n";
  const cut = findingsMarkdownForParse(md);
  if (cut.includes("Previous findings")) {
    throw new Error("section should be removed for parsing");
  }
});
