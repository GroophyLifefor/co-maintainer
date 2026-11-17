/** The MCP part of `prepareReviewTools` (issue 79): which modes start a
 * repository's servers, the off switch, the fork rule in `serve`, and that
 * servers started while another part failed are stopped. */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { ToolHandler } from "../ai/mermaid_loop.ts";
import { writeRepoConfig } from "../config.ts";
import { offlineEnv, type OfflineEnv } from "../testing/offline_env.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDir,
} from "../testing/runtime.ts";
import type { McpServerConfig } from "../tools/mcp_config.ts";
import type { McpSession } from "../tools/mcp_tools.ts";
import type { Json } from "../types.ts";
import {
  mcpAllowedForPull,
  prepareReviewTools,
  pullFromFork,
  type ReviewToolSource,
  startMcp,
} from "./review_tools.ts";

let env: OfflineEnv;
let dir: string;
before(async () => {
  dir = await tempDir();
  env = offlineEnv(dir);
});
after(async () => {
  env.restore();
  await removePath(dir, { recursive: true });
});

const REPO = "acme/widgets";
const SERVERS: Record<string, McpServerConfig> = {
  tracker: { command: "node", tools: ["get_issue"] },
};

beforeEach(async () => {
  await writeRepoConfig(REPO, {
    mcpServers: SERVERS,
    mcpAllowForks: undefined,
  });
});

function tool(name: string): ToolHandler {
  return {
    name,
    tool: { type: "function", function: { name } },
    run: () => "",
  };
}

/** A start that records what it was given and whether it was stopped. */
function fakeStart() {
  const started: Record<string, McpServerConfig>[] = [];
  let stopped = 0;
  const start = (servers: Record<string, McpServerConfig>) => {
    started.push(servers);
    const session: McpSession = {
      tools: [tool("mcp-tracker-get_issue")],
      servers: ["tracker"],
      warnings: () => [],
      privateResults: () => [],
      stop: async () => {
        stopped++;
      },
    };
    return Promise.resolve(session);
  };
  return { start, started, stopped: () => stopped };
}

const tree = (mcp?: boolean): ReviewToolSource => ({
  kind: "tree",
  root: dir,
  codegraph: [],
  mcp,
});

test("local, remote and pull request sources that ask for MCP start the repository's servers", async () => {
  for (const source of [
    tree(true),
    { kind: "bridge", tools: [], mcp: true } as ReviewToolSource,
  ]) {
    const fake = fakeStart();
    const session = await startMcp(source, REPO, { mcp: fake.start });
    assert.deepEqual(fake.started, [SERVERS]);
    assert.deepEqual(session.servers, ["tracker"]);
  }
});

test("a source without mcp, such as a push review, starts none", async () => {
  const fake = fakeStart();
  for (const source of [
    tree(),
    { kind: "checkout", pr: 0, commit: "abc", search: false },
  ] as ReviewToolSource[]) {
    const session = await startMcp(source, REPO, { mcp: fake.start });
    assert.deepEqual(session.tools, []);
  }
  assert.deepEqual(fake.started, []);
});

test("CM_MCP_DISABLED=1 starts no server, and a repository without servers starts none", async () => {
  const fake = fakeStart();
  const saved = getEnv("CM_MCP_DISABLED");
  setEnv("CM_MCP_DISABLED", "1");
  try {
    await startMcp(tree(true), REPO, { mcp: fake.start });
  } finally {
    if (saved === undefined) deleteEnv("CM_MCP_DISABLED");
    else setEnv("CM_MCP_DISABLED", saved);
  }
  await startMcp(tree(true), "acme/other", { mcp: fake.start });
  assert.deepEqual(fake.started, []);
});

test("MCP tools come last, after the diff's own tools", async () => {
  const fake = fakeStart();
  const tools = await prepareReviewTools(
    tree(true),
    { repo: REPO, useCodegraph: false },
    [tool("read-full-diff")],
    { mcp: fake.start, search: { maxContextLines: 3, instructions: null } },
  );
  assert.deepEqual(
    tools.tools.map((item) => item.name),
    ["search-non-code", "read-full-diff", "mcp-tracker-get_issue"],
  );
  assert.deepEqual(tools.mcp.servers, ["tracker"]);
});

test("servers that started while the diff failed are stopped", async () => {
  const fake = fakeStart();
  await assert.rejects(
    prepareReviewTools(
      tree(true),
      { repo: REPO, useCodegraph: false },
      Promise.reject(new Error("diff failed")),
      { mcp: fake.start, search: { maxContextLines: 3, instructions: null } },
    ),
    /diff failed/,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.stopped(), 1);
});

const pull = (headRepo: string | null): Json => ({
  head: { repo: headRepo === null ? null : { full_name: headRepo } },
  base: { repo: { full_name: REPO } },
});

test("serve: a pull request from a fork gets MCP only with mcpAllowForks", async () => {
  assert.equal(pullFromFork(pull("Acme/Widgets"), REPO), false);
  assert.equal(pullFromFork(pull("mallory/widgets"), REPO), true);
  // A deleted fork leaves no head repository.
  assert.equal(pullFromFork(pull(null), REPO), true);
  assert.equal(mcpAllowedForPull(pull(REPO), REPO), true);
  assert.equal(mcpAllowedForPull(pull("mallory/widgets"), REPO), false);
  await writeRepoConfig(REPO, { mcpAllowForks: true });
  assert.equal(mcpAllowedForPull(pull("mallory/widgets"), REPO), true);
});
