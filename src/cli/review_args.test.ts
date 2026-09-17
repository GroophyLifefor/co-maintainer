import { parseReviewArgs } from "./review_args.ts";

Deno.test("parseReviewArgs: PR mode strips local-only flags before parseArgs", () => {
  const parsed = parseReviewArgs([
    "owner/repo",
    "42",
    "--json",
    "--fresh",
    "--to-branch=main",
    "--log-time",
    "--token=test",
    "--high-model=test/model",
  ]);
  if (parsed.mode !== "pr") throw new Error(`mode ${parsed.mode}`);
  if (!parsed.json || !parsed.fresh) throw new Error("flags not captured");
  if (parsed.options.prNumber !== 42) {
    throw new Error(`pr ${parsed.options.prNumber}`);
  }
});

Deno.test("parseReviewArgs: --remote selects remote mode", () => {
  const parsed = parseReviewArgs(["--remote"]);
  if (parsed.mode !== "remote") {
    throw new Error(`expected remote mode, got ${parsed.mode}`);
  }
});
