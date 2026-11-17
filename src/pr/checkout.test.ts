import { ensureClone, ensureCommit } from "./checkout.ts";
import { clearGitHubAuthForTest, setGitHubAuth } from "./git_auth.ts";
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
 * directory, the loser failing with "already exists" and its caller falling
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
      // `-c core.longpaths=true` has to precede the clone subcommand.
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
  // The one line is git's reason, not its opening "Cloning into ...".
  if (
    !message.endsWith("fatal: could not read Username for 'https://github.com'")
  ) {
    throw new Error(`the reason is missing: ${message}`);
  }
});

test("an App job's clone and fetch carry its token in the environment only", async () => {
  const clonesRoot = await tempDir();
  const prev = getEnv("CM_CLONES_DIR");
  setEnv("CM_CLONES_DIR", clonesRoot);
  const seen: { args: string[]; env?: Record<string, string> }[] = [];
  const run: Run = async (_command, args, _cwd, env) => {
    seen.push({ args, env });
    if (args.includes("clone")) {
      await mkdirPath(`${args[args.length - 1]}/.git`, { recursive: true });
    }
    // `rev-parse`/`cat-file` find nothing, so `ensureCommit` fetches.
    if (args.includes("rev-parse") || args.includes("cat-file")) {
      return { code: 1, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const repo = `auth-test/${crypto.randomUUID()}`;
  try {
    setGitHubAuth(repo, async () => "app-token-123");
    const dir = await ensureClone(repo, run);
    await ensureCommit(dir, "a".repeat(40), run).catch(() => {});
    const want = `AUTHORIZATION: basic ${Buffer.from("x-access-token:app-token-123").toString("base64")}`;
    for (const name of ["clone", "fetch"]) {
      const call = seen.find((item) => item.args.includes(name));
      if (!call) throw new Error(`no git ${name} ran`);
      if (call.env?.GIT_CONFIG_VALUE_0 !== want) {
        throw new Error(`git ${name} env: ${JSON.stringify(call.env)}`);
      }
      if (call.args.join(" ").includes("app-token-123")) {
        throw new Error(`the token is on the git ${name} command line`);
      }
    }
    // A repository no App job registered keeps the machine's own login.
    seen.length = 0;
    await ensureClone(`auth-test/${crypto.randomUUID()}`, run);
    if (seen.find((item) => item.args.includes("clone"))?.env !== undefined) {
      throw new Error("an unregistered clone got an auth environment");
    }
  } finally {
    clearGitHubAuthForTest();
    if (prev === undefined) deleteEnv("CM_CLONES_DIR");
    else setEnv("CM_CLONES_DIR", prev);
    await removePath(clonesRoot, { recursive: true });
  }
});

test("an App token that cannot be minted fails the clone instead of using the machine's login", async () => {
  const clonesRoot = await tempDir();
  const prev = getEnv("CM_CLONES_DIR");
  setEnv("CM_CLONES_DIR", clonesRoot);
  const cloned: string[][] = [];
  const run: Run = async (_command, args) => {
    if (args.includes("clone")) cloned.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  const repo = `auth-fail/${crypto.randomUUID()}`;
  try {
    setGitHubAuth(repo, async () => {
      throw new Error("GitHub API 401");
    });
    let message = "";
    await ensureClone(repo, run).catch((error: Error) => {
      message = error.message;
    });
    if (!message.includes("could not get the App token")) {
      throw new Error(`clone did not fail on the token: ${message}`);
    }
    if (cloned.length > 0)
      throw new Error("git clone ran without the App token");
  } finally {
    clearGitHubAuthForTest();
    if (prev === undefined) deleteEnv("CM_CLONES_DIR");
    else setEnv("CM_CLONES_DIR", prev);
    await removePath(clonesRoot, { recursive: true });
  }
});
