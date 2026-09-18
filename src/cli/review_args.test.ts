import { parseReviewArgs } from "./review_args.ts";
import { test } from "node:test";

test("parseReviewArgs: PR mode strips local-only flags before parseArgs", async () => {
  const parsed = await parseReviewArgs([
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

test("parseReviewArgs: --remote selects remote mode", async () => {
  const parsed = await parseReviewArgs(["--remote"]);
  if (parsed.mode !== "remote") {
    throw new Error(`expected remote mode, got ${parsed.mode}`);
  }
});
