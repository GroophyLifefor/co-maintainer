/** The copied-passage check: 8-word runs, case, punctuation, and the parts of
 * a rendered review it leaves alone. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MCP_PRIVATE_GUIDANCE,
  PRIVATE_TEXT_REMOVED,
  privateTextWarning,
  removePrivateText,
} from "./private_text.ts";

const PRIVATE =
  "Acme Corp reported that the export button silently drops every row after the first thousand entries.";

test("a run of 8 words from a private result is removed, 7 are kept", () => {
  const eight = "Sadly export button silently drops every row after the limit.";
  const kept = removePrivateText(
    "Note: the export button silently drops every row here.",
    [PRIVATE],
  );
  // "the export button silently drops every row" is 7 words.
  assert.deepEqual(kept, {
    text: "Note: the export button silently drops every row here.",
    removed: 0,
  });
  assert.deepEqual(removePrivateText(eight, [PRIVATE]), {
    text: `Sadly ${PRIVATE_TEXT_REMOVED} limit.`,
    removed: 1,
  });
});

test("case and punctuation do not hide a copied passage", () => {
  const result = removePrivateText(
    'Body: "EXPORT button, silently -- drops every ROW after the first!" so fix it.',
    [PRIVATE],
  );
  assert.equal(result.removed, 1);
  assert.equal(result.text, `Body: "${PRIVATE_TEXT_REMOVED}!" so fix it.`);
});

test("a passage that wraps a line in one paragraph is found, two passages count twice", () => {
  const text = [
    "Sadly export button silently drops",
    "every row after the first thousand entries, and also",
    "",
    "Acme Corp reported that the export button silently drops.",
  ].join("\n");
  const result = removePrivateText(text, [PRIVATE]);
  assert.equal(result.removed, 2);
  assert.equal(
    result.text,
    [
      `Sadly ${PRIVATE_TEXT_REMOVED}, and also`,
      "",
      `${PRIVATE_TEXT_REMOVED}.`,
    ].join("\n"),
  );
});

test("headings, location lines and a clean suggestion block are left alone", () => {
  const review = [
    "## Findings",
    "",
    "### [P2 · non-blocking] `src/export.ts`",
    "Location: `src/export.ts:10`",
    "",
    "Acme Corp reported that the export button silently drops rows.",
    "",
    "Suggestion: `src/export.ts:10`",
    "```suggestion",
    "// the export button keeps every row after the first thousand entries",
    "```",
    "```text",
    "Acme Corp reported that the export button silently drops every row",
    "```",
  ].join("\n");
  const result = removePrivateText(review, [PRIVATE]);
  assert.equal(result.removed, 2);
  const lines = result.text.split("\n");
  assert.equal(lines[5], `${PRIVATE_TEXT_REMOVED} rows.`);
  assert.deepEqual(lines.slice(7, 10), [
    "Suggestion: `src/export.ts:10`",
    "```suggestion",
    "// the export button keeps every row after the first thousand entries",
  ]);
  // The text block held a copied passage, so it is replaced whole.
  assert.equal(lines[11], PRIVATE_TEXT_REMOVED);
  assert.equal(lines.length, 12);
});

test("a heading that copies a passage is checked too, and its marks are kept", () => {
  const review = [
    "### [P1 · blocking] `src/export.ts`: `Acme Corp reported that the export button silently drops`",
    "Location: `src/export.ts:10`",
  ].join("\n");
  const result = removePrivateText(review, [PRIVATE]);
  assert.equal(result.removed, 1);
  assert.equal(
    result.text.split("\n")[0],
    `### [P1 · blocking] \`src/export.ts\`: \`${PRIVATE_TEXT_REMOVED}\``,
  );
  assert.equal(result.text.split("\n")[1], "Location: `src/export.ts:10`");
});

test("a passage split over the lines of a code block is still found", () => {
  const words = PRIVATE.split(" ");
  const half = Math.floor(words.length / 2);
  const review = [
    "Some prose.",
    "",
    "```text",
    words.slice(0, half).join(" "),
    words.slice(half).join(" "),
    "```",
  ].join("\n");
  const result = removePrivateText(review, [PRIVATE]);
  assert.ok(result.removed >= 1);
  assert.ok(!result.text.includes(words.slice(half - 4, half + 4).join(" ")));
  assert.equal(result.text.split("\n").at(-1), PRIVATE_TEXT_REMOVED);
});

test("a suggestion block with a copied passage is dropped with its Suggestion line and counted", () => {
  const review = [
    "### [P2 · non-blocking] `src/export.ts`",
    "Location: `src/export.ts:10`",
    "",
    "The export loop stops early.",
    "",
    "Suggestion: `src/export.ts:10-11`",
    "```suggestion",
    "// Acme Corp reported that the export button",
    "// silently drops every row after the first thousand entries",
    "```",
    "",
    "Suggestion: `src/export.ts:20`",
    "```suggestion",
    "// Acme Corp reported that the export button silently drops every row",
  ].join("\n");
  const result = removePrivateText(review, [PRIVATE]);
  assert.equal(result.removed, 2);
  assert.equal(
    result.text,
    [
      "### [P2 · non-blocking] `src/export.ts`",
      "Location: `src/export.ts:10`",
      "",
      "The export loop stops early.",
      "",
      PRIVATE_TEXT_REMOVED,
      "",
      PRIVATE_TEXT_REMOVED,
    ].join("\n"),
  );
  assert.deepEqual(
    privateTextWarning(result.removed)[0]!.code,
    "private_text_removed",
  );
});

test("no private result leaves the text as it is", () => {
  assert.deepEqual(removePrivateText(PRIVATE, []), {
    text: PRIVATE,
    removed: 0,
  });
  assert.deepEqual(removePrivateText(PRIVATE, ["too short"]), {
    text: PRIVATE,
    removed: 0,
  });
});

test("the warning counts removals and the prompt sentence is the issue's", () => {
  assert.deepEqual(privateTextWarning(0), []);
  assert.deepEqual(privateTextWarning(1), [
    {
      code: "private_text_removed",
      message:
        "1 passage copied from a private MCP result was removed from this review.",
    },
  ]);
  assert.match(privateTextWarning(3)[0]!.message, /^3 passages .* were /);
  assert.equal(
    MCP_PRIVATE_GUIDANCE,
    "Results from mcp- tools are private. Base a finding on them when they show the change is wrong, and say only that a private source of this repository requires it. Never quote, paraphrase or summarize their text in a finding.",
  );
});
