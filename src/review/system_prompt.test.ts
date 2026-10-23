/** The per-repository custom review instructions: the cap, the validator and
 * the system-prompt section they build. */
import { test } from "node:test";
import {
  checkReviewSystemPrompt,
  DEFAULT_REVIEW_SYSTEM_PROMPT_MAX_CHARS,
  reviewSystemPromptBlock,
  reviewSystemPromptLimit,
} from "./system_prompt.ts";

function must(value: boolean, what: string): void {
  if (!value) throw new Error(what);
}

test("the cap is the default when unset and unlimited for 0 or a negative", () => {
  must(
    reviewSystemPromptLimit(undefined) ===
      DEFAULT_REVIEW_SYSTEM_PROMPT_MAX_CHARS,
    "unset is the default",
  );
  must(
    reviewSystemPromptLimit({}) === DEFAULT_REVIEW_SYSTEM_PROMPT_MAX_CHARS,
    "an empty repo config is the default",
  );
  must(
    reviewSystemPromptLimit({ reviewSystemPromptMaxChars: 100 }) === 100,
    "a number",
  );
  must(
    reviewSystemPromptLimit({ reviewSystemPromptMaxChars: 0 }) === null,
    "0",
  );
  must(
    reviewSystemPromptLimit({ reviewSystemPromptMaxChars: -1 }) === null,
    "-1",
  );
});

test("the validator only rejects text over the cap", () => {
  must(checkReviewSystemPrompt("ok", 5) === null, "under the cap");
  must(checkReviewSystemPrompt("exact", 5) === null, "at the cap");
  must(checkReviewSystemPrompt("too long", 5) !== null, "over the cap");
  must(checkReviewSystemPrompt("anything", null) === null, "no cap");
});

test("no section is added when nothing is configured", () => {
  must(reviewSystemPromptBlock({}) === "", "empty options");
  must(
    reviewSystemPromptBlock({ reviewSystemPrompt: "   " }) === "",
    "blank text is off",
  );
});

test("the configured text becomes a CUSTOM REVIEW INSTRUCTIONS section", () => {
  const block = reviewSystemPromptBlock({ reviewSystemPrompt: "Focus on X." });
  must(block.startsWith("\n\nCUSTOM REVIEW INSTRUCTIONS:\n"), "the heading");
  must(block.includes("Focus on X."), "the text");
});

test("override replaces the configured section and add stacks on top", () => {
  const configured = { reviewSystemPrompt: "Configured." };
  const overrideOnly = reviewSystemPromptBlock({
    ...configured,
    reviewSystemPromptOverride: "Override.",
  });
  must(!overrideOnly.includes("Configured."), "override drops the configured");
  must(overrideOnly.includes("Override."), "override wins");

  const withAdd = reviewSystemPromptBlock({
    ...configured,
    reviewSystemPromptAdd: "Extra.",
  });
  must(withAdd.includes("Configured."), "add keeps the configured");
  must(withAdd.includes("Extra."), "add is present");
  must(
    withAdd.indexOf("Configured.") < withAdd.indexOf("Extra."),
    "add comes after the configured text",
  );

  const overrideAndAdd = reviewSystemPromptBlock({
    ...configured,
    reviewSystemPromptOverride: "Override.",
    reviewSystemPromptAdd: "Extra.",
  });
  must(!overrideAndAdd.includes("Configured."), "override still drops it");
  must(overrideAndAdd.includes("Override."), "override present");
  must(overrideAndAdd.includes("Extra."), "add present");

  // A blank per-run override counts as absent, so the repository's own section
  // survives an empty override file.
  const blankOverride = reviewSystemPromptBlock({
    ...configured,
    reviewSystemPromptOverride: "   ",
  });
  must(blankOverride.includes("Configured."), "blank override keeps it");
});
