import { ensureClone } from "./checkout.ts";
import type { CommandResult, Run } from "./checkout.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  removePath,
  setEnv,
  tempDir,
} from "../testing/runtime.ts";
import { test } from "node:test";

/** Reproduces the race a benchmark run hits at `--review-concurrent` > 1:
 * several jobs for the same repo call `ensureClone` before the clone exists,
 * see nothing on disk, and used to all invoke `git clone` into the same
 * directory — the loser failing with "already exists" and its caller falling
 * back to an unscoped review. `ensureClone` should invoke `git clone` exactly
 * once no matter how many callers race in. */
test("ensureClone clones exactly once under concurrent callers", async () => {
  const clonesRoot = await tempDir();
  const prev = getEnv("CM_CLONES_DIR");
  setEnv("CM_CLONES_DIR", clonesRoot);
  let cloneInvocations = 0;
  let cloneResolve!: () => void;
  const clonePending = new Promise<void>((resolve) => {
    cloneResolve = resolve;
  });
  const run: Run = async (_command, args): Promise<CommandResult> => {
    if (args.includes("clone")) {
      cloneInvocations++;
      // CORE-11: `-c core.longpaths=true` has to precede the clone subcommand.
      if (args[0] !== "-c" || args[1] !== "core.longpaths=true") {
        throw new Error(
          `longpaths is not in effect for the clone: ${args.join(" ")}`,
        );
      }
      // Held open until every caller has had a chance to race in, so a real
      // race would actually manifest rather than finishing before the other
      // callers even start.
      await clonePending;
      const dir = args[args.length - 1];
      await mkdirPath(`${dir}/.git`, { recursive: true });
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
    throw new Error(`expected exactly one git clone, got ${cloneInvocations}`);
  }
  if (new Set(dirs).size !== 1) {
    throw new Error(
      "all concurrent callers must resolve to the same directory",
    );
  }
  if (prev === undefined) deleteEnv("CM_CLONES_DIR");
  else setEnv("CM_CLONES_DIR", prev);
  await removePath(clonesRoot, { recursive: true });
});

test("ensureClone reports a clone failure as one actionable line", async () => {
  const clonesRoot = await tempDir();
  const prev = getEnv("CM_CLONES_DIR");
  setEnv("CM_CLONES_DIR", clonesRoot);
  const run: Run = async (_command, args): Promise<CommandResult> => {
    if (args.includes("clone")) {
      // A realistic multi-line git transcript, which must not leak verbatim.
      return {
        code: 128,
        stdout: "",
        stderr:
          "Cloning into 'x'...\nfatal: could not read Username for 'https://github.com'\n" +
          "extra explanatory noise that should not reach the user\n",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  let message = "";
  try {
    await ensureClone(`fail-test/${crypto.randomUUID()}`, run);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (prev === undefined) deleteEnv("CM_CLONES_DIR");
  else setEnv("CM_CLONES_DIR", prev);
  await removePath(clonesRoot, { recursive: true });

  if (message === "") throw new Error("a failed clone did not throw");
  if (message.includes("\n")) {
    throw new Error(
      `the message is multi-line, so raw git leaked:\n${message}`,
    );
  }
  if (!message.includes("exit 128")) {
    throw new Error(`the exit code is missing: ${message}`);
  }
  if (!message.includes("diff only")) {
    throw new Error(`what is lost is not stated: ${message}`);
  }
});
