/** `prepareReviewTools` (issue 79): one tool list for every mode. The pull
 * request checkout no longer lives inside the codegraph setup, so a review has
 * search without codegraph, and `codegraphState` comes from codegraph alone. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ToolHandler } from "../ai/mermaid_loop.ts";
import type { CommandResult, Run } from "./checkout.ts";
import { codegraphState, prepareReviewTools } from "./review_tools.ts";
import { offlineEnv, type OfflineEnv } from "../testing/offline_env.ts";
import { removePath, tempDir } from "../testing/runtime.ts";
import { worktreeDir } from "../config.ts";

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

const SEARCH = { maxContextLines: 3, instructions: null };
const OPTIONS = { repo: "acme/widgets", useCodegraph: true };

function tool(name: string): ToolHandler {
  return {
    name,
    tool: { type: "function", function: { name } },
    run: () => "",
  };
}
const CODEGRAPH = [tool("codegraph-callers"), tool("codegraph-node")];
const DIFF = [tool("read-full-diff")];
const names = (tools: ToolHandler[]) => tools.map((item) => item.name);

/** A git that answers every command, recording each one. */
function fakeGit(): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = (_command, args): Promise<CommandResult> => {
    calls.push(args);
    if (args[0] === "rev-parse") {
      return Promise.resolve({ code: 0, stdout: "abc123\n", stderr: "" });
    }
    if (args[0] === "cat-file") {
      return Promise.resolve({ code: 0, stdout: "commit\n", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { run, calls };
}

test("local review: codegraph, search at the git root, then read-full-diff", async () => {
  const tools = await prepareReviewTools(
    { kind: "tree", root: "/repo", codegraph: CODEGRAPH },
    OPTIONS,
    DIFF,
    { search: SEARCH },
  );
  assert.deepEqual(names(tools.tools), [
    "codegraph-callers",
    "codegraph-node",
    "search-non-code",
    "read-full-diff",
  ]);
  assert.deepEqual(names(tools.codegraph), names(CODEGRAPH));
  const off = await prepareReviewTools(
    { kind: "tree", root: "/repo", codegraph: [] },
    { ...OPTIONS, useCodegraph: false },
    DIFF,
    { search: SEARCH },
  );
  assert.deepEqual(names(off.tools), ["search-non-code", "read-full-diff"]);
  assert.equal(codegraphState(false, off.codegraph), "disabled");
});

test("remote review: the client's tools, codegraph only when it offered codegraph", async () => {
  const bridged = [...CODEGRAPH, tool("search-non-code")];
  const on = await prepareReviewTools(
    { kind: "bridge", tools: bridged },
    OPTIONS,
    DIFF,
  );
  assert.deepEqual(names(on.tools), [...names(bridged), "read-full-diff"]);
  assert.equal(codegraphState(true, on.codegraph), "used");
  // A client with codegraph off still offers search, and search alone never
  // makes codegraph look used.
  const searchOnly = await prepareReviewTools(
    { kind: "bridge", tools: [tool("search-non-code")] },
    { ...OPTIONS, useCodegraph: false },
    DIFF,
  );
  assert.deepEqual(names(searchOnly.tools), [
    "search-non-code",
    "read-full-diff",
  ]);
  assert.deepEqual(searchOnly.codegraph, []);
  assert.equal(codegraphState(false, searchOnly.codegraph), "disabled");
});

test("pull request review: one checkout serves search without codegraph", async () => {
  const { run, calls } = fakeGit();
  const tools = await prepareReviewTools(
    { kind: "checkout", pr: 7, commit: "abc123", search: true },
    { ...OPTIONS, useCodegraph: false },
    Promise.resolve(DIFF),
    {
      run,
      search: SEARCH,
      codegraph: () => {
        throw new Error("codegraph is off");
      },
    },
  );
  assert.deepEqual(names(tools.tools), ["search-non-code", "read-full-diff"]);
  assert.ok(
    calls.some(
      (args) =>
        args[0] === "worktree" && args.includes(worktreeDir("acme/widgets", 7)),
    ),
    JSON.stringify(calls),
  );
});

test("pull request review with codegraph: the checkout is made once and handed to codegraph", async () => {
  const { run, calls } = fakeGit();
  let tree: string | undefined;
  const tools = await prepareReviewTools(
    { kind: "checkout", pr: 8, commit: "abc123", search: true },
    OPTIONS,
    DIFF,
    {
      run,
      search: SEARCH,
      codegraph: async (worktree) => {
        tree = await worktree();
        return CODEGRAPH;
      },
    },
  );
  assert.equal(tree, worktreeDir("acme/widgets", 8));
  assert.equal(calls.filter((args) => args[0] === "worktree").length, 1);
  assert.deepEqual(names(tools.tools), [
    "codegraph-callers",
    "codegraph-node",
    "search-non-code",
    "read-full-diff",
  ]);
  assert.equal(codegraphState(true, tools.codegraph), "used");
});

test("a checkout that fails leaves search out and the review goes on", async () => {
  const run: Run = () => Promise.reject(new Error("no clone"));
  const tools = await prepareReviewTools(
    { kind: "checkout", pr: 9, commit: "abc123", search: true },
    OPTIONS,
    DIFF,
    {
      run,
      search: SEARCH,
      codegraph: async (worktree) => {
        await worktree().catch(() => {});
        return [];
      },
    },
  );
  assert.deepEqual(names(tools.tools), ["read-full-diff"]);
  assert.equal(codegraphState(true, tools.codegraph), "unavailable");
});

test("a push review without codegraph makes no checkout and offers no search", async () => {
  const { run, calls } = fakeGit();
  const tools = await prepareReviewTools(
    { kind: "checkout", pr: 0, commit: "abc123", search: false },
    { ...OPTIONS, useCodegraph: false },
    DIFF,
    { run, search: SEARCH },
  );
  assert.deepEqual(names(tools.tools), ["read-full-diff"]);
  assert.deepEqual(calls, []);
});
