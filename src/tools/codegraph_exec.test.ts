import { runCodegraphTool } from "./codegraph_exec.ts";
import { test } from "node:test";

test("runCodegraphTool surfaces non-zero exit", async () => {
  const runner = async () => ({
    code: 2,
    stdout: "",
    stderr: "boom",
  });
  const text = await runCodegraphTool("cg", ["query", "x"], "/wt", runner);
  if (!text.includes("exited 2") || !text.includes("boom")) {
    throw new Error(text);
  }
});
