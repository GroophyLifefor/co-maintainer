/** Windows exit crash regression tests (CORE-11).
 *
 * F08: `process.exit` while undici's fetch connection pool is still open trips
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c,
 * line 94` on Windows, and the process dies with 0xC0000409 (surfaced as 127 by
 * some shells, -1073740791 here) instead of the documented exit code.
 *
 * The reproduction needs two things at once: a real socket opened through
 * `fetch`, and an error that reaches the top level so the CLI actually exits.
 * A fake AI provider would not open a socket, and `init` quarantines provider
 * errors instead of propagating them, so the case that hits this is a *local
 * review against a real provider that fails*: the socket is real and the
 * provider error is not caught. These tests run the real CLI as a child process
 * in exactly that configuration.
 *
 * A second, independent bug: the review heartbeat's `setInterval` was only
 * cleared on the success path, so an error left it running, the event loop
 * never drained, and the exit code never landed.
 */
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandOutput,
  envToObject,
  makeTempDir,
  mkdir,
  remove,
  writeTextFile,
} from "../util/runtime.ts";
import {
  Command,
  runtimeExecPath,
  runtimeRunArgs,
} from "../testing/runtime.ts";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";
import { fakeGhBin } from "../testing/cli_harness.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** 0xC0000409 as Node surfaces the libuv assertion abort. */
const WINDOWS_ABORT = 0xc0000409;

type Run = { code: number; stdout: string; stderr: string };

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string = projectRoot,
): Promise<Run> {
  const result = await commandOutput(runtimeExecPath(), {
    // The entrypoint is absolute because `cwd` may be a temp worktree.
    args: runtimeRunArgs(join(projectRoot, "main.ts"), args),
    cwd,
    env: { ...envToObject(), ...env },
    stdout: "piped",
    stderr: "piped",
  });
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function assertNoAbort(run: Run): void {
  if (run.code === WINDOWS_ABORT) {
    throw new Error(
      `the process aborted with the Windows handle assertion (0x${WINDOWS_ABORT.toString(16)}):\n${run.stderr}`,
    );
  }
  if (/Assertion failed|uv_handle|libuv/i.test(run.stderr)) {
    throw new Error(`libuv assertion on stderr:\n${run.stderr}`);
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await new Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  }
}

/** A committed git worktree with one uncommitted change, which is all local
 * review needs to build a revision. No network, no `gh`. */
async function makeWorktree(root: string, repo: string): Promise<string> {
  const worktree = `${root}/worktree`;
  await mkdir(worktree, { recursive: true });
  await git(worktree, ["init"]);
  await git(worktree, ["config", "user.email", "t@t"]);
  await git(worktree, ["config", "user.name", "t"]);
  await writeTextFile(`${worktree}/x.ts`, "export {}\n");
  await git(worktree, ["add", "x.ts"]);
  await git(worktree, ["commit", "-m", "init"]);
  await git(worktree, ["branch", "-M", "main"]);
  await git(worktree, ["remote", "add", "origin", `https://github.com/${repo}.git`]);
  await git(worktree, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await writeTextFile(`${worktree}/x.ts`, "export const y = 1\n");
  await git(worktree, ["add", "x.ts"]);
  await git(worktree, ["commit", "-m", "change"]);
  return worktree;
}

test("exit: a failing provider after a real fetch exits 3 without aborting", async () => {
  const server = await startFakeOpenRouter("unauthorized");
  const root = await makeTempDir({ prefix: "cm-exit-fetch-" });
  try {
    const repo = "e2e-exit/provider";
    const repoDir = `${root}/repos/${repo}`;
    await mkdir(repoDir, { recursive: true });
    await writeTextFile(`${repoDir}/PR_REVIEW_GUIDE.md`, "# Review guide\n\nBe terse.\n");
    const configPath = `${root}/config.json`;
    await writeTextFile(
      configPath,
      `${JSON.stringify(
        {
          auth: "gh",
          ai: "openrouter",
          token: "fake-key",
          lowModel: "fake/model",
          highModel: "fake/model",
        },
        null,
        2,
      )}\n`,
    );
    const worktree = await makeWorktree(root, repo);

    const result = await runCli(
      ["review", "--json", `--repo=${repo}`, "--disable-codegraph"],
      {
        CM_CONFIG_PATH: configPath,
        CM_REPOS_DIR: `${root}/repos`,
        CM_OPENROUTER_URL: server.url,
        CM_GH_BIN: fakeGhBin().command,
        CM_GH_SCRIPT: fakeGhBin().script,
        // no CM_FAKE_AI: the real provider has to open a socket
      },
      worktree,
    );
    assertNoAbort(result);
    if (server.requests.length === 0) {
      throw new Error(
        `the CLI never reached the server, so no socket was opened:\n${result.stderr}`,
      );
    }
    // The 401 is a runtime failure and the local review does not quarantine it,
    // so it must reach the top level and become exit 3.
    if (result.code !== 3) {
      throw new Error(
        `exit ${result.code} (want 3):\n${result.stdout}\n${result.stderr}`,
      );
    }
  } finally {
    await remove(root, { recursive: true });
    await server.close();
  }
});

test("exit: an unknown command exits 2 without a crash", async () => {
  const root = await makeTempDir({ prefix: "cm-exit-usage-" });
  try {
    const result = await runCli(["prob", "e2e-exit/repo"], {
      CM_CONFIG_PATH: `${root}/config.json`,
      CM_REPOS_DIR: `${root}/repos`,
    });
    assertNoAbort(result);
    if (result.code !== 2) {
      throw new Error(`exit ${result.code} (want 2): ${result.stderr}`);
    }
    if (!result.stderr.includes("Unknown command: prob")) {
      throw new Error(`stderr: ${result.stderr}`);
    }
  } finally {
    await remove(root, { recursive: true });
  }
});

test("exit: `--help` still exits 0", async () => {
  const root = await makeTempDir({ prefix: "cm-exit-help-" });
  try {
    const result = await runCli(["--help"], {
      CM_CONFIG_PATH: `${root}/config.json`,
      CM_REPOS_DIR: `${root}/repos`,
    });
    if (result.code !== 0) {
      throw new Error(`exit ${result.code}: ${result.stderr}`);
    }
    if (!result.stdout.includes("Usage:")) {
      throw new Error(`no usage output: ${result.stdout}`);
    }
  } finally {
    await remove(root, { recursive: true });
  }
});
