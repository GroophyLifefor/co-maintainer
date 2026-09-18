import { parseArgs } from "./args.ts";
import { test } from "node:test";

test("parseArgs: review without PR number is valid for local CLI", async () => {
  const options = await parseArgs([
    "review",
    "owner/repo",
    "--token=test",
    "--high-model=test/model",
  ]);
  if (options.command !== "review" || options.prNumber !== undefined) {
    throw new Error(JSON.stringify(options));
  }
});

test("parseArgs: review enables codegraph unless disabled", async () => {
  const on = await parseArgs([
    "review",
    "owner/repo",
    "--token=test",
    "--high-model=test/model",
  ]);
  if (!on.useCodegraph) throw new Error("expected codegraph on by default");
  const off = await parseArgs([
    "review",
    "owner/repo",
    "--disable-codegraph",
    "--token=test",
    "--high-model=test/model",
  ]);
  if (off.useCodegraph) throw new Error("expected codegraph off");
});
