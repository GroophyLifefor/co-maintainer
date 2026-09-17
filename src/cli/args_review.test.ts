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
