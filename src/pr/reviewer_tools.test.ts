/** The review side of issue 79: a review offers `search-non-code` where it has
 * a tree to search and says so next to codegraph, tool results count as
 * evidence, one gate spans the review, and the outcome carries `usage.tools`
 * and the `tool_budget_spent` warning. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs, setCliInteractive } from "../cli/args.ts";
import type { Revision } from "../review/revision.ts";
import type { AiProvider, AiRequest, AiResponse, Options } from "../types.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import {
  reviewSystemPrompt,
  reviewWorkspaceRevision,
  SEARCH_NON_CODE_GUIDANCE,
} from "./reviewer.ts";
import type { ReviewToolSource } from "./review_tools.ts";
import { TOOL_BUDGET_SPENT } from "../ai/tool_gate.ts";

/** Asks for two searches in the first answer, then answers. */
class SearchingProvider implements AiProvider {
  requests: AiRequest[] = [];

  complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(structuredClone(request));
    const base = {
      tokensIn: 1,
      tokensOut: 1,
      provider: "openrouter" as const,
      model: "test",
    };
    if (this.requests.length > 1) {
      return Promise.resolve({
        ...base,
        text: JSON.stringify({ findings: [] }),
      });
    }
    const search = (id: string, pattern: string) => ({
      id,
      type: "function" as const,
      function: {
        name: "search-non-code",
        arguments: JSON.stringify({ pattern }),
      },
    });
    return Promise.resolve({
      ...base,
      text: "",
      toolCalls: [search("call-1", "RATE_LIMIT"), search("call-2", "Routes")],
    });
  }
}

const REVISION: Revision = {
  title: "",
  description: "",
  baseLabel: "main",
  producer: "local",
  files: [
    {
      path: "src/limits.ts",
      previousPath: null,
      status: "modified",
      binary: false,
      additions: 1,
      deletions: 0,
      patch:
        "@@ -1,1 +1,2 @@\n export const RATE_LIMIT = 60;\n+export const ALL = true;",
    },
  ],
};

/** One workspace review in a fresh config and repository, with `repoConfig`
 * saved for `acme/widgets`. */
async function review(
  source: (root: string) => ReviewToolSource | undefined,
  repoConfig: Record<string, unknown> = {},
) {
  const dir = tempDirSync();
  const saved = {
    config: getEnv("CM_CONFIG_PATH"),
    repos: getEnv("CM_REPOS_DIR"),
  };
  try {
    setEnv("CM_CONFIG_PATH", join(dir, "config.json"));
    setEnv("CM_REPOS_DIR", join(dir, "repos"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ repos: { "acme/widgets": repoConfig } }),
    );
    mkdirSync(join(dir, "repos/acme/widgets"), { recursive: true });
    writeFileSync(
      join(dir, "repos/acme/widgets/PR_REVIEW_GUIDE.md"),
      "Review small changes.",
    );
    const root = join(dir, "tree");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "docs/operations.md"),
      "Routes without an entry in RATE_LIMIT are not limited.\n",
    );
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    setCliInteractive(false);
    const options: Options = {
      ...(await parseArgs([
        "review",
        "acme/widgets",
        "--token=test",
        "--low-model=low/model",
        "--high-model=test/model",
      ])),
      useCodegraph: false,
    };
    const provider = new SearchingProvider();
    const tools = source(root);
    const outcome = await reviewWorkspaceRevision(
      REVISION,
      options,
      "abc123",
      undefined,
      provider,
      undefined,
      tools ? { tools } : {},
    );
    return { outcome, requests: provider.requests };
  } finally {
    setCliInteractive(true);
    if (saved.config === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", saved.config);
    if (saved.repos === undefined) deleteEnv("CM_REPOS_DIR");
    else setEnv("CM_REPOS_DIR", saved.repos);
    rmSync(dir, { recursive: true, force: true });
  }
}

const offered = (request: AiRequest | undefined) =>
  (request?.tools ?? []).map(
    (tool) => (tool as { function?: { name?: string } }).function?.name,
  );

const toolResults = (request: AiRequest | undefined) =>
  (request?.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content));

test("a review with a tree offers search, says so next to codegraph, and reports its use", async () => {
  const { outcome, requests } = await review((root) => ({
    kind: "tree",
    root,
    codegraph: [],
  }));
  assert.ok(offered(requests[0]).includes("search-non-code"));
  assert.ok(requests[0]?.prompt.includes(SEARCH_NON_CODE_GUIDANCE));
  assert.ok(
    SEARCH_NON_CODE_GUIDANCE ===
      "Use search-non-code for docs, configuration and other files codegraph does not index. Use codegraph for code.",
  );
  const [first] = toolResults(requests[1]);
  assert.match(first ?? "", /^docs\/operations\.md:1: Routes without/);
  assert.equal(outcome.codegraphState, "disabled");
  assert.equal(outcome.tools.calls, 2);
  assert.equal(outcome.tools.rounds, 1);
  assert.deepEqual(outcome.tools.byTool, { "search-non-code": 2 });
  assert.equal(outcome.tools.budgetSpent, false);
  assert.ok(!outcome.warnings.some((w) => w.code === "tool_budget_spent"));
});

test("the repository's tool budget spans the review and warns once spent", async () => {
  const { outcome, requests } = await review(
    (root) => ({ kind: "tree", root, codegraph: [] }),
    { reviewToolBudgetChars: 10 },
  );
  const [first, second] = toolResults(requests[1]);
  // Ten characters leave no room for the cut notice, so only the text that
  // fits is sent.
  assert.equal(first, "docs/opera");
  assert.equal(second, TOOL_BUDGET_SPENT);
  assert.equal(outcome.tools.budgetSpent, true);
  assert.ok(outcome.warnings.some((w) => w.code === "tool_budget_spent"));
});

test("a review with no tree to search neither offers search nor mentions it", async () => {
  const { requests } = await review(() => undefined);
  assert.ok(!offered(requests[0]).includes("search-non-code"));
  assert.ok(!requests[0]?.prompt.includes("search-non-code"));
});

test("tool results count as evidence", () => {
  assert.match(
    reviewSystemPrompt(true),
    /Evidence must come from the supplied diff, the review guide and the results\nof the tools you call\./,
  );
});
