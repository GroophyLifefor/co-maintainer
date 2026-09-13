import { ensureClone } from "./checkout.ts";
import type { CommandResult, Run } from "./checkout.ts";

/** Reproduces the race a benchmark run hits at `--review-concurrent` > 1:
 * several jobs for the same repo call `ensureClone` before the clone exists,
 * see nothing on disk, and used to all invoke `git clone` into the same
 * directory — the loser failing with "already exists" and its caller falling
 * back to an unscoped review. `ensureClone` should invoke `git clone` exactly
 * once no matter how many callers race in. */
Deno.test("ensureClone clones exactly once under concurrent callers", async () => {
  let cloneInvocations = 0;
  let cloneResolve!: () => void;
  const clonePending = new Promise<void>((resolve) => {
    cloneResolve = resolve;
  });
  const run: Run = async (_command, args): Promise<CommandResult> => {
    if (args[0] === "clone") {
      cloneInvocations++;
      // Held open until every caller has had a chance to race in, so a real
      // race would actually manifest rather than finishing before the other
      // callers even start.
      await clonePending;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const repo = `race-test/${crypto.randomUUID()}`;
  const calls = Array.from({ length: 8 }, () => ensureClone(repo, run));
  // Give every call's leading `pathExists` a turn before releasing the clone.
  await new Promise((resolve) => setTimeout(resolve, 20));
  cloneResolve();
  const dirs = await Promise.all(calls);

  if (cloneInvocations !== 1) {
    throw new Error(
      `expected exactly one git clone, got ${cloneInvocations}`,
    );
  }
  if (new Set(dirs).size !== 1) {
    throw new Error(
      "all concurrent callers must resolve to the same directory",
    );
  }
});
