/** `review --remote` inline flags and the HTTPS path (CORE-25 / F33).
 *
 * Two layers: argument handling runs in process, and the end-to-end case runs
 * the real CLI against a fake remote server over real TLS, because the point
 * is that a `https://` host plus an inline token works without a saved config.
 */
import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReviewArgs } from "./review_args.ts";
import { runRemoteReview } from "../remote/client.ts";
import {
  bearerOf,
  startFakeRemote,
  writeCaCert,
} from "../testing/fake_remote.ts";
import { CliError } from "./error.ts";
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

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("review: an inline remote host without --remote is refused", async () => {
  let error: CliError | undefined;
  try {
    await parseReviewArgs(["--remote-host=https://x"]);
  } catch (thrown) {
    error = thrown as CliError;
  }
  if (!(error instanceof CliError)) {
    throw new Error("an inline remote host without --remote was accepted");
  }
  if (error.exitCode !== 2) throw new Error(`exit ${error.exitCode} (want 2)`);
  if (!/require --remote/.test(error.message)) {
    throw new Error(`message: ${error.message}`);
  }
});

test("review: an inline remote token is captured for remote mode", async () => {
  const parsed = await parseReviewArgs([
    "--remote",
    "--remote-host=https://review.example.com",
    "--remote-token=cmr_x",
  ]);
  if (parsed.mode !== "remote") throw new Error(`mode ${parsed.mode}`);
  if (parsed.remoteHost !== "https://review.example.com") {
    throw new Error(`host: ${parsed.remoteHost}`);
  }
  if (parsed.remoteToken !== "cmr_x") {
    throw new Error(`token: ${parsed.remoteToken}`);
  }
});

test("review: an inline host is refused for PR mode", async () => {
  let error: CliError | undefined;
  try {
    await parseReviewArgs([
      "owner/repo",
      "42",
      "--remote-host=https://x",
      "--token=test",
    ]);
  } catch (thrown) {
    error = thrown as CliError;
  }
  if (!(error instanceof CliError)) {
    throw new Error("an inline host was accepted for PR review");
  }
  if (error.exitCode !== 2) throw new Error(`exit ${error.exitCode} (want 2)`);
});

test("review: the not-configured hint names config set", async () => {
  const root = await makeTempDir({ prefix: "cm-remote-hint-" });
  const prev = process.env.CM_CONFIG_PATH;
  process.env.CM_CONFIG_PATH = `${root}/config.json`;
  await writeTextFile(`${root}/config.json`, "{}");
  let error: CliError | undefined;
  try {
    await runRemoteReview({
      mode: "remote",
      rawArgs: [],
      json: true,
      remote: true,
      disableCodegraph: true,
      allowToolInstall: false,
      fresh: false,
      remakeBeforeReview: false,
    });
  } catch (thrown) {
    error = thrown as CliError;
  } finally {
    if (prev === undefined) delete process.env.CM_CONFIG_PATH;
    else process.env.CM_CONFIG_PATH = prev;
    await remove(root, { recursive: true });
  }
  if (!(error instanceof CliError)) {
    throw new Error("an unconfigured remote review did not fail");
  }
  if (!/config set remote-host/.test(error.hint ?? "")) {
    throw new Error(`hint: ${error.hint}`);
  }
  if (!/config set remote-token/.test(error.hint ?? "")) {
    throw new Error(`hint: ${error.hint}`);
  }
});

test("review: inline host and token reach an https server with no saved config", async () => {
  const remote = await startFakeRemote({ repo: "e2e-exit/remote" });
  const root = await makeTempDir({ prefix: "cm-remote-tls-" });
  try {
    const ca = await writeCaCert(root);
    // No remoteHost/remoteToken here: the flags have to supply both.
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

    const worktree = `${root}/worktree`;
    await mkdir(worktree, { recursive: true });
    const git = async (args: string[]): Promise<void> => {
      const result = await new Command("git", {
        args,
        cwd: worktree,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!result.success) {
        throw new Error(
          `git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`,
        );
      }
    };
    await git(["init"]);
    await git(["config", "user.email", "t@t"]);
    await git(["config", "user.name", "t"]);
    await writeTextFile(`${worktree}/x.ts`, "export {}\n");
    await git(["add", "x.ts"]);
    await git(["commit", "-m", "init"]);
    await git(["branch", "-M", "main"]);
    await git([
      "remote",
      "add",
      "origin",
      "https://github.com/e2e-exit/remote.git",
    ]);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await writeTextFile(`${worktree}/x.ts`, "export const y = 1\n");
    await git(["commit", "-am", "change"]);

    const result = await commandOutput(runtimeExecPath(), {
      args: runtimeRunArgs(`${projectRoot}/main.ts`, [
        "review",
        "--remote",
        `--remote-host=${remote.url}`,
        "--remote-token=cmr_inline",
        "--json",
        "--disable-codegraph",
      ]),
      cwd: worktree,
      env: {
        ...envToObject(),
        CM_CONFIG_PATH: configPath,
        CM_REPOS_DIR: `${root}/repos`,
        // The fake server's CA is not in the OS trust store, so the child is
        // told to trust exactly this one.
        NODE_EXTRA_CA_CERTS: ca,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    if (result.code !== 0) {
      throw new Error(`exit ${result.code}\n${stdout}\n${stderr}`);
    }
    const parsed = JSON.parse(stdout) as { mode?: string; ok?: boolean };
    if (parsed.mode !== "remote" || parsed.ok !== true) {
      throw new Error(`json: ${stdout}`);
    }
    const handshake = remote.requests.find(
      (r) => r.path === "/api/remote/handshake",
    );
    if (handshake?.authorization !== "Bearer cmr_inline") {
      throw new Error(
        `the inline token did not reach the server: ${handshake?.authorization}`,
      );
    }
    if (bearerOf(handshake!) !== "cmr_inline") {
      throw new Error("bearer helper disagrees with the header");
    }
    if (!remote.requests.some((r) => r.path === "/api/remote/reviews")) {
      throw new Error("the review was never submitted");
    }
  } finally {
    await remove(root, { recursive: true });
    await remote.close();
  }
});
