import type { Run } from "../pr/checkout.ts";
import { perFileUnifiedPatch } from "./git_revision.ts";

Deno.test("perFileUnifiedPatch: extracts hunk body from single-file diff", async () => {
  const stdout =
    "diff --git a/src/a.ts b/src/a.ts\n" +
    "index 111..222 100644\n" +
    "--- a/src/a.ts\n" +
    "+++ b/src/a.ts\n" +
    "@@ -1 +1 @@\n" +
    "-old\n" +
    "+new\n";
  const run: Run = async (cmd, args) => {
    if (cmd !== "git" || !args.includes("src/a.ts")) {
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    }
    return { code: 0, stdout, stderr: "" };
  };
  const patch = await perFileUnifiedPatch("/repo", "abc123", "src/a.ts", run);
  if (!patch.startsWith("@@") || !patch.includes("+new")) {
    throw new Error(patch);
  }
});
