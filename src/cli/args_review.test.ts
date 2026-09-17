import { parseArgs } from "./args.ts";

Deno.test("parseArgs: review without PR number is valid for local CLI", () => {
  const options = parseArgs([
    "review",
    "owner/repo",
    "--token=test",
    "--high-model=test/model",
  ]);
  if (options.command !== "review" || options.prNumber !== undefined) {
    throw new Error(JSON.stringify(options));
  }
});

Deno.test("parseArgs: review enables codegraph unless disabled", () => {
  const on = parseArgs([
    "review",
    "owner/repo",
    "--token=test",
    "--high-model=test/model",
  ]);
  if (!on.useCodegraph) throw new Error("expected codegraph on by default");
  const off = parseArgs([
    "review",
    "owner/repo",
    "--disable-codegraph",
    "--token=test",
    "--high-model=test/model",
  ]);
  if (off.useCodegraph) throw new Error("expected codegraph off");
});
