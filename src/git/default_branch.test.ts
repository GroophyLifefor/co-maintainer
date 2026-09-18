import type { Run } from "../pr/checkout.ts";
import {
  detectDefaultBranchRef,
  resolveDefaultBranchName,
} from "./default_branch.ts";
import { test } from "node:test";

test("default_branch: uses upstream remote ref", async () => {
  const run: Run = async (_cmd, args) => {
    if (args.includes("refs/remotes/upstream/HEAD")) {
      return { code: 0, stdout: "refs/remotes/upstream/main\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  const ref = await detectDefaultBranchRef("/clone", "upstream", run);
  if (ref !== "refs/remotes/upstream/main") throw new Error(String(ref));
  const name = await resolveDefaultBranchName("/clone", "upstream", run);
  if (name !== "main") throw new Error(String(name));
});
