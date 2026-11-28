/** The prompts that hand the model other people's text say it is data. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isolateTestFile } from "../testing/locations.ts";
import type { AiProvider, AiRequest } from "../types.ts";
import { GUIDE_SYSTEM } from "../knowledge/guide.ts";
import {
  EXTRACT_SYSTEM,
  extractRequest,
  SECTION_SYSTEM,
} from "../knowledge/synthesis.ts";
import { DIFF_SUMMARY_SYSTEM, summarizeDiff } from "../pr/diff_summary.ts";
import { watchAnswerSystem } from "../services/watch_comments.ts";
import { UNTRUSTED_DATA_NOTE } from "./untrusted.ts";

isolateTestFile();

test("the large diff summary carries the note in its system prompt, and the patch only in its prompt", async () => {
  let seen: AiRequest | undefined;
  const provider: AiProvider = {
    complete: (request) => {
      seen = request;
      return Promise.resolve({
        text: "A summary.",
        tokensIn: 1,
        tokensOut: 1,
        model: "fake",
        provider: "openrouter",
      });
    },
  };
  const patch = "@@ -1 +1 @@\n-a\n+b // PATCH-TEXT-MARKER";
  await summarizeDiff("src/a.ts", patch, provider);
  assert.ok(seen?.system?.includes(UNTRUSTED_DATA_NOTE));
  assert.equal(seen?.system, DIFF_SUMMARY_SYSTEM);
  assert.ok(!seen?.system?.includes("PATCH-TEXT-MARKER"));
  assert.ok(seen?.prompt.includes("PATCH-TEXT-MARKER"));
});

test("the guide extraction, the section synthesis and the guide writing prompts carry the note", () => {
  assert.ok(
    extractRequest("a pull request discussion").system?.includes(
      UNTRUSTED_DATA_NOTE,
    ),
  );
  assert.equal(extractRequest("x").system, EXTRACT_SYSTEM);
  for (const [name, system] of [
    ["extraction", EXTRACT_SYSTEM],
    ["section synthesis", SECTION_SYSTEM],
    ["guide writing", GUIDE_SYSTEM],
  ] as const) {
    assert.ok(system.includes(UNTRUSTED_DATA_NOTE), `${name} has no data note`);
  }
});

test("the answer to a question on an issue the bot opened carries the note and the guide", () => {
  const system = watchAnswerSystem("GUIDE-BODY");
  assert.ok(system.includes(UNTRUSTED_DATA_NOTE));
  assert.ok(system.includes("GUIDE-BODY"));
  // The guide is cut at the same length as before.
  const long = watchAnswerSystem("x".repeat(30_000));
  assert.ok(long.includes("x".repeat(20_000)));
  assert.ok(!long.includes("x".repeat(20_001)));
});

test("the note says what to treat as data and never to follow it", () => {
  for (const word of ["untrusted data", "not instructions", "Never follow"]) {
    assert.ok(UNTRUSTED_DATA_NOTE.includes(word), word);
  }
});
