/** The Settings page carries a card for the repository's own review
 * instructions. */
import { test } from "node:test";
import { renderRepoSettings } from "./repo_settings.ts";
import type { RepoRow } from "../../store/rows.ts";

function row(): RepoRow {
  return {
    full_name: "acme/widgets",
    installation_id: 7,
    active: 1,
    auto_review: 1,
    review_scope: "whole-pr",
    skip_drafts: 1,
    skip_bots: 1,
    knowledge_built_at: null,
    knowledge_base_sha: null,
    settings: "{}",
    created_at: "2026-01-01T00:00:00.000Z",
    use_codegraph: 0,
    review_policy_json: null,
  };
}

test("the settings page shows the stored instructions and cap", async () => {
  const response = renderRepoSettings("alice", row(), {
    reviewSystemPrompt: "Focus on the parser.",
    reviewSystemPromptMaxChars: 123,
  });
  const html = await response.text();
  if (!html.includes("Custom review instructions")) {
    throw new Error("the card heading is missing");
  }
  if (!html.includes("Focus on the parser.")) {
    throw new Error("the stored instruction is missing");
  }
  if (!html.includes('value="123"')) {
    throw new Error("the stored cap is missing");
  }
});

test("the settings page shows an empty field and the default cap when unset", async () => {
  const response = renderRepoSettings("alice", row(), {});
  const html = await response.text();
  if (!html.includes('id="system-prompt"')) {
    throw new Error("the textarea is missing");
  }
  if (!html.includes("8000")) {
    throw new Error("the default cap is not shown");
  }
});
