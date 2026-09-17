import { codegraphTools, prepareCodegraphTools } from "./codegraph_tools.ts";
import type { CommandResult } from "./checkout.ts";
import type { CodegraphRunner } from "../tools/codegraph_exec.ts";

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

function capturingRun(): { run: CodegraphRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CodegraphRunner = (_binary, args): Promise<CommandResult> => {
    calls.push(args);
    return Promise.resolve({ code: 0, stdout: "ok", stderr: "" });
  };
  return { run, calls };
}

function tool(tools: ReturnType<typeof codegraphTools>, name: string) {
  const found = tools.find((item) => item.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

Deno.test("codegraph-query builds the right command", async () => {
  const { run, calls } = capturingRun();
  const tools = codegraphTools("codegraph", "/wt", run);
  await tool(tools, "codegraph-query").run({
    search: "readFullDiff",
    kind: "function",
    limit: 5,
  });
  same(
    calls[0],
    ["query", "readFullDiff", "-k", "function", "-l", "5"],
    "args",
  );
});

Deno.test("codegraph-node supports symbol mode and file mode", async () => {
  const { run, calls } = capturingRun();
  const tools = codegraphTools("codegraph", "/wt", run);
  await tool(tools, "codegraph-node").run({ name: "Builder" });
  same(calls[0], ["node", "Builder"], "symbol mode");
  await tool(tools, "codegraph-node").run({
    file: "src/a.ts",
    symbolsOnly: true,
  });
  same(calls[1], ["node", "-f", "src/a.ts", "--symbols-only"], "file mode");
});

Deno.test("codegraph-node without name or file is rejected before shelling out", async () => {
  const { run, calls } = capturingRun();
  const tools = codegraphTools("codegraph", "/wt", run);
  const message = await tool(tools, "codegraph-node").run({});
  same(calls.length, 0, "no subprocess spawned");
  if (!message.includes("requires")) throw new Error(message);
});

Deno.test("codegraph-explore splits a plain-words query into separate args", async () => {
  const { run, calls } = capturingRun();
  const tools = codegraphTools("codegraph", "/wt", run);
  await tool(tools, "codegraph-explore").run({
    query: "rate limiting middleware",
    maxFiles: 3,
  });
  same(
    calls[0],
    ["explore", "rate", "limiting", "middleware", "--max-files", "3"],
    "args",
  );
});

Deno.test("codegraph-callers, codegraph-callees, codegraph-impact build their own commands", async () => {
  const { run, calls } = capturingRun();
  const tools = codegraphTools("codegraph", "/wt", run);
  await tool(tools, "codegraph-callers").run({ symbol: "foo", limit: 20 });
  await tool(tools, "codegraph-callees").run({ symbol: "foo" });
  await tool(tools, "codegraph-impact").run({ symbol: "foo", depth: 3 });
  same(calls[0], ["callers", "foo", "-l", "20"], "callers");
  same(calls[1], ["callees", "foo"], "callees");
  same(calls[2], ["impact", "foo", "-d", "3"], "impact");
});

Deno.test("codegraph-affected passes every file and rejects an empty list", async () => {
  const { run, calls } = capturingRun();
  const tools = codegraphTools("codegraph", "/wt", run);
  await tool(tools, "codegraph-affected").run({
    files: ["a.ts", "b.ts"],
    depth: 2,
  });
  same(calls[0], ["affected", "a.ts", "b.ts", "-d", "2"], "args");
  const empty = await tool(tools, "codegraph-affected").run({ files: [] });
  same(calls.length, 1, "no subprocess for an empty file list");
  if (!empty.includes("requires")) throw new Error(empty);
});

Deno.test("a failed command reports its exit code and output instead of throwing", async () => {
  const run: CodegraphRunner = () =>
    Promise.resolve({ code: 1, stdout: "", stderr: "not found" });
  const tools = codegraphTools("codegraph", "/wt", run);
  const message = await tool(tools, "codegraph-callers").run({
    symbol: "missing",
  });
  if (!message.includes("exited 1") || !message.includes("not found")) {
    throw new Error(message);
  }
});

Deno.test("prepareCodegraphTools returns no tools, not an error, when codegraph is missing", async () => {
  const tools = await prepareCodegraphTools("owner/repo", 1, "sha", {
    detect: () => Promise.resolve({ state: "missing" }),
  });
  same(tools, [], "empty");
});

Deno.test("prepareCodegraphTools returns no tools when the worktree cannot be prepared", async () => {
  const tools = await prepareCodegraphTools("owner/repo", 1, "sha", {
    detect: () =>
      Promise.resolve({ state: "ok", version: "1.6.0", path: "codegraph" }),
    run: () => Promise.reject(new Error("no clone")),
  });
  same(tools, [], "empty");
});
