import { test } from "node:test";
import assert from "node:assert/strict";
import {
  referenceLine,
  referencesBlock,
  resolveReferences,
} from "./references.ts";
import type { RulesFile } from "../knowledge/rules.ts";
import { findingsMarkdownFromJson } from "../pr/findings_json.ts";
import { parseFindings } from "../pr/findings.ts";

const rules: RulesFile = {
  schemaVersion: 1,
  builtAt: "",
  rules: {
    R12: {
      file: "PR_REVIEW_GUIDE.md",
      text: "Percentages round half up",
      sources: [
        {
          pr: 212,
          mergedAt: "2026-01-10",
          url: "https://github.com/o/r/pull/212#discussion_r1",
        },
        { pr: 340, mergedAt: "2026-03-02" },
      ],
    },
    I3: {
      file: "INSTRUCTIONS.md",
      text: "Use pnpm",
      commit: "abc123",
      sources: [{ path: "AGENTS.md", line: 14 }],
    },
  },
};
const codebase = "# Codebase\n\n## Tests\n\n- Run the tests.\n";

test("ids resolve to references, a made-up id is dropped, and nothing usable means System Prompt", () => {
  const resolved = resolveReferences(
    ["R12", "I3", "codebase:Tests", "R999", "system", "R12"],
    { repo: "o/r", rules, codebase },
  );
  assert.deepEqual(
    resolved.map((reference) => referenceLine(reference, false)),
    [
      "Rules-12 · #212, #340 · 2026-03",
      "Instructions-3 · AGENTS.md:14",
      "Codebase · Tests",
      "System Prompt",
    ],
  );
  assert.deepEqual(
    resolveReferences(["R999"], { repo: "o/r", rules, codebase }),
    [{ kind: "system" }],
  );
  // A section the codebase file does not have is not shown as one.
  assert.equal(
    referenceLine(
      resolveReferences(["codebase:Made Up"], {
        repo: "o/r",
        rules,
        codebase,
      })[0],
    ),
    "Codebase",
  );
});

test("the comment block links the review comment, leaves an unlinked pull request plain, and passes the copy check", () => {
  const block = referencesBlock(
    resolveReferences(["R12", "I3"], { repo: "o/r", rules, codebase }),
  );
  assert.equal(
    block,
    [
      "<details><summary>References (2)</summary>",
      "",
      "- Rules-12 · [#212](https://github.com/o/r/pull/212#discussion_r1), #340 · 2026-03",
      "- Instructions-3 · [AGENTS.md:14](https://github.com/o/r/blob/abc123/AGENTS.md#L14)",
      "",
      "</details>",
    ].join("\n"),
  );
  // A posted review refuses copy with a semicolon or a long dash.
  assert.equal(/[;\u2014]/.test(block), false);
});

test("the ids a review answer names survive the Markdown round trip and stay out of the body", () => {
  const markdown = findingsMarkdownFromJson(
    JSON.stringify({
      findings: [
        {
          severity: "P1",
          blocking: true,
          path: "src/a.ts",
          lineFrom: 3,
          title: "Rounds half down",
          body: "This rounds half down.\nReferences: a body line is not taken",
          references: ["R12", "codebase:Tests"],
        },
      ],
    }),
  );
  const [finding] = parseFindings(markdown ?? "");
  assert.deepEqual(finding?.references, ["R12", "codebase:Tests"]);
  assert.equal(
    finding?.excerpt,
    "This rounds half down.\nReferences: a body line is not taken",
  );
});
