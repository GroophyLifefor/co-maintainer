/** `review --remote` inline flags and the HTTPS path (CORE-25 / F33).
 *
 * Two layers: argument handling runs in process, and the end-to-end case runs
 * the real CLI against a fake remote server over real TLS, because the point
 * is that a `https://` host plus an inline token works without a saved config.
 */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReviewArgs } from "./review_args.ts";
import { byokHttpWarning, runRemoteReview } from "../remote/client.ts";
import {
  bearerOf,
  startFakeRemote,
  writeCaCert,
  type FakeRemoteOptions,
} from "../testing/fake_remote.ts";
import { CliError } from "./error.ts";
import { tempDirSync } from "../testing/runtime.ts";
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

test("review: --remote-byok without a configured key is refused", async () => {
  const root = await makeTempDir({ prefix: "cm-remote-byok-hint-" });
  const prev = process.env.CM_CONFIG_PATH;
  process.env.CM_CONFIG_PATH = `${root}/config.json`;
  await writeTextFile(
    `${root}/config.json`,
    JSON.stringify({ remoteHost: "https://x", remoteToken: "tok" }),
  );
  let error: CliError | undefined;
  try {
    await runRemoteReview({
      mode: "remote",
      rawArgs: [],
      json: true,
      remote: true,
      remoteByok: true,
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
    throw new Error("a BYOK run with no key did not fail");
  }
  if (error.message !== "No BYOK key is set.") {
    throw new Error(`message: ${error.message}`);
  }
  if (!/config set remote-byok/.test(error.hint ?? "")) {
    throw new Error(`hint: ${error.hint}`);
  }
});

test("byokHttpWarning: warns for a plain-http, non-local host", () => {
  const warning = byokHttpWarning("http://review.example.com");
  if (!warning || !/plain http to review\.example\.com/.test(warning)) {
    throw new Error(`warning: ${warning}`);
  }
});

test("byokHttpWarning: stays quiet for http on localhost", () => {
  if (byokHttpWarning("http://localhost:8080") !== null) {
    throw new Error("localhost should not warn");
  }
  if (byokHttpWarning("http://127.0.0.1:8080") !== null) {
    throw new Error("127.0.0.1 should not warn");
  }
});

test("byokHttpWarning: stays quiet for https", () => {
  if (byokHttpWarning("https://review.example.com") !== null) {
    throw new Error("https should not warn");
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

/** Shared setup for the CORE-111 BYOK end-to-end cases: a fake remote server,
 * a config file and a one-commit git worktree with an uncommitted change to
 * review, so only the fake server's handshake and the flags differ per test. */
async function withByokWorktreeReview(
  opts: {
    fakeRemote?: FakeRemoteOptions;
    reviewArgs?: string[];
    /** Adds `--json` (the default). A test of another output leaves it out. */
    json?: boolean;
    /** Passes `--remote-host` and `--remote-token` (the default). A test of the
     * environment variables leaves them out. */
    remoteFlags?: boolean;
    configPatch?: Record<string, unknown>;
    env?: Record<string, string>;
  },
  run: (result: {
    code: number | null;
    stdout: string;
    stderr: string;
    remote: Awaited<ReturnType<typeof startFakeRemote>>;
  }) => void | Promise<void>,
): Promise<void> {
  const remote = await startFakeRemote({
    repo: "e2e-exit/remote",
    ...opts.fakeRemote,
  });
  const root = await makeTempDir({ prefix: "cm-remote-byok-e2e-" });
  try {
    const ca = await writeCaCert(root);
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
          ...opts.configPatch,
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
        ...(opts.remoteFlags === false
          ? []
          : [`--remote-host=${remote.url}`, "--remote-token=cmr_inline"]),
        ...(opts.json === false ? [] : ["--json"]),
        "--disable-codegraph",
        ...(opts.reviewArgs ?? []),
      ]),
      cwd: worktree,
      env: {
        ...envToObject(),
        CM_CONFIG_PATH: configPath,
        CM_REPOS_DIR: `${root}/repos`,
        NODE_EXTRA_CA_CERTS: ca,
        ...Object.fromEntries(
          Object.entries(opts.env ?? {}).map(([key, value]) => [
            key,
            value.replace("@URL@", remote.url),
          ]),
        ),
      },
      stdout: "piped",
      stderr: "piped",
    });
    await run({
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      remote,
    });
  } finally {
    await remove(root, { recursive: true });
    await remote.close();
  }
}

test("review --remote-byok: fails against a server that predates BYOK", async () => {
  await withByokWorktreeReview(
    {
      // No `handshake` override: the fake server answers exactly like a
      // pre-CORE-110 0.5.0 server, with no `features` field at all.
      reviewArgs: ["--remote-byok"],
      configPatch: { remoteByok: "sk-test-123" },
    },
    ({ code, stdout }) => {
      if (code === 0) throw new Error(`unexpectedly succeeded: ${stdout}`);
      const parsed = JSON.parse(stdout) as {
        error?: { message?: string; hint?: string };
      };
      if (!/does not support your own key/.test(parsed.error?.message ?? "")) {
        throw new Error(`message: ${parsed.error?.message}`);
      }
    },
  );
});

test("review --remote-byok: fails when the server's policy is off", async () => {
  await withByokWorktreeReview(
    {
      fakeRemote: {
        handshake: {
          features: ["byok"],
          byok: { policy: "off" },
          ai: { provider: "openrouter" },
        },
      },
      reviewArgs: ["--remote-byok"],
      configPatch: { remoteByok: "sk-test-123" },
    },
    ({ code, stdout }) => {
      if (code === 0) throw new Error(`unexpectedly succeeded: ${stdout}`);
      const parsed = JSON.parse(stdout) as {
        error?: { message?: string };
      };
      if (
        parsed.error?.message !== "This server does not accept your own key."
      ) {
        throw new Error(`message: ${parsed.error?.message}`);
      }
    },
  );
});

test("review: fails when the server requires BYOK and the run did not send one", async () => {
  await withByokWorktreeReview(
    {
      fakeRemote: {
        handshake: {
          features: ["byok"],
          byok: { policy: "require" },
          ai: { provider: "openrouter" },
        },
      },
    },
    ({ code, stdout }) => {
      if (code === 0) throw new Error(`unexpectedly succeeded: ${stdout}`);
      const parsed = JSON.parse(stdout) as {
        error?: { message?: string; hint?: string };
      };
      if (parsed.error?.message !== "This server requires your own key.") {
        throw new Error(`message: ${parsed.error?.message}`);
      }
      if (!/--remote-byok/.test(parsed.error?.hint ?? "")) {
        throw new Error(`hint: ${parsed.error?.hint}`);
      }
    },
  );
});

test("review --remote-byok: the key reaches the server in the submit body, not the auth header", async () => {
  await withByokWorktreeReview(
    {
      fakeRemote: {
        handshake: {
          features: ["byok"],
          byok: { policy: "allow" },
          ai: { provider: "openrouter" },
        },
      },
      reviewArgs: ["--remote-byok"],
      env: { CM_REMOTE_BYOK: "sk-env-key" },
      // A config value is also set, so this proves the env var wins.
      configPatch: { remoteByok: "sk-config-key" },
    },
    ({ code, stdout, stderr, remote }) => {
      if (code !== 0) throw new Error(`exit ${code}\n${stdout}\n${stderr}`);
      const submit = remote.requests.find(
        (r) => r.path === "/api/remote/reviews",
      );
      const body = submit?.body as { byok?: { key?: string } } | undefined;
      if (body?.byok?.key !== "sk-env-key") {
        throw new Error(`submit byok.key: ${JSON.stringify(body?.byok)}`);
      }
      const handshake = remote.requests.find(
        (r) => r.path === "/api/remote/handshake",
      );
      if (bearerOf(handshake!) !== "cmr_inline") {
        throw new Error(
          "the server token, not the BYOK key, must authenticate",
        );
      }
      if (bearerOf(submit!) !== "cmr_inline") {
        throw new Error("the BYOK key leaked into the auth header");
      }
    },
  );
});

const REMOTE_FINDINGS = [
  {
    id: "f1",
    state: "new",
    closeReason: null,
    severity: "P1",
    blocking: true,
    path: "src/a.ts",
    lineFrom: 3,
    lineTo: 5,
    title: "[P1 · blocking] `src/a.ts`: `run`",
    body: "Handle null.\n::add-mask::hunter2\n100% sure",
    suggestion: null,
  },
  {
    id: "f2",
    state: "open",
    closeReason: null,
    severity: "P3",
    blocking: false,
    path: "src/b.ts",
    lineFrom: 9,
    lineTo: 9,
    title: "[P3 · non-blocking] `src/b.ts`: `name`",
    body: "Rename it.",
    suggestion: null,
  },
  {
    id: "f3",
    state: "closed",
    closeReason: "fixed",
    severity: "P2",
    blocking: false,
    path: "src/old.ts",
    lineFrom: 1,
    lineTo: 1,
    title: "[P2 · non-blocking] `src/old.ts`: `gone`",
    body: "Fixed.",
    suggestion: null,
  },
];

function doneWith(findings: unknown[], usage: unknown) {
  return [
    {
      schemaVersion: 1,
      status: "done",
      logs: [],
      result: { findings, summary: {}, usage },
      abort: null,
    },
  ];
}

test("review --remote --output=github prints only escaped annotations, writes the summary and exits 1 on a blocking finding", async () => {
  const summaryFile = `${tempDirSync()}/summary.md`;
  await withByokWorktreeReview(
    {
      json: false,
      reviewArgs: ["--output=github"],
      fakeRemote: {
        sync: doneWith(REMOTE_FINDINGS, {
          tokensIn: 3125,
          tokensOut: 1308,
          costUsd: null,
          costNote: "provider_did_not_report",
        }),
      },
      env: { GITHUB_STEP_SUMMARY: summaryFile },
    },
    ({ code, stdout, stderr }) => {
      if (code !== 1) throw new Error(`exit ${code}\n${stdout}\n${stderr}`);
      const lines = stdout.split("\n").filter((line) => line !== "");
      if (lines.length !== 2) throw new Error(`stdout:\n${stdout}`);
      for (const line of lines) {
        if (!line.startsWith("::")) {
          throw new Error(`only workflow commands may reach stdout: ${line}`);
        }
      }
      if (
        !lines[0]!.startsWith(
          "::error file=src/a.ts,line=3,endLine=5,title=P1%3A run::Handle null.%0A::add-mask::hunter2%0A100%25 sure",
        )
      ) {
        throw new Error(lines[0]);
      }
      if (!lines[1]!.startsWith("::warning file=src/b.ts,line=9,")) {
        throw new Error(lines[1]);
      }
      if (stdout.includes("old.ts"))
        throw new Error("a closed finding was annotated");
      const summary = readFileSync(summaryFile, "utf8");
      for (const part of [
        "## co-maintainer review",
        "| P1 (blocking) | new | src/a.ts:3-5 |",
        "| P3 | open | src/b.ts:9 |",
        "1 new · 1 open · 1 closed · 1 blocking",
        "cost unknown (The provider did not report the cost for this review.)",
      ]) {
        if (!summary.includes(part))
          throw new Error(`missing "${part}" in\n${summary}`);
      }
    },
  );
});

test("review --remote --output=github exits 0 when nothing blocks, and still annotates a warning", async () => {
  await withByokWorktreeReview(
    {
      json: false,
      reviewArgs: ["--output=github"],
      fakeRemote: { sync: doneWith([REMOTE_FINDINGS[1]], undefined) },
    },
    ({ code, stdout, stderr }) => {
      if (code !== 0) throw new Error(`exit ${code}\n${stdout}\n${stderr}`);
      if (!stdout.startsWith("::warning file=src/b.ts,"))
        throw new Error(stdout);
    },
  );
});

test("review --output=github with --json is refused before anything runs", async () => {
  await withByokWorktreeReview(
    { json: false, reviewArgs: ["--output=github", "--json"] },
    ({ code, stdout, stderr, remote }) => {
      if (code !== 2) throw new Error(`exit ${code}\n${stdout}\n${stderr}`);
      if (remote.requests.length !== 0) {
        throw new Error(
          "the server must not be contacted for a refused command",
        );
      }
    },
  );
});

test("review --remote reads the host and the token from the environment when no flag is given", async () => {
  await withByokWorktreeReview(
    {
      remoteFlags: false,
      env: { CM_REMOTE_HOST: "@URL@", CM_REMOTE_TOKEN: "cmr_from_env" },
    },
    ({ code, stdout, stderr, remote }) => {
      if (code !== 0) throw new Error(`exit ${code}\n${stdout}\n${stderr}`);
      const handshake = remote.requests.find(
        (r) => r.path === "/api/remote/handshake",
      );
      if (bearerOf(handshake!) !== "cmr_from_env") {
        throw new Error(
          `the env token did not reach the server: ${handshake?.authorization}`,
        );
      }
    },
  );
});

test("a flag beats the environment, and the environment beats the saved config", async () => {
  await withByokWorktreeReview(
    {
      env: {
        CM_REMOTE_HOST: "https://wrong.invalid",
        CM_REMOTE_TOKEN: "cmr_wrong",
      },
    },
    ({ code, stdout, stderr, remote }) => {
      if (code !== 0) throw new Error(`exit ${code}\n${stdout}\n${stderr}`);
      const handshake = remote.requests.find(
        (r) => r.path === "/api/remote/handshake",
      );
      if (bearerOf(handshake!) !== "cmr_inline") {
        throw new Error("the flag must win over the environment");
      }
    },
  );
  await withByokWorktreeReview(
    {
      remoteFlags: false,
      configPatch: {
        remoteHost: "https://config.invalid",
        remoteToken: "cmr_config",
      },
      env: { CM_REMOTE_HOST: "@URL@", CM_REMOTE_TOKEN: "cmr_from_env" },
    },
    ({ code, stdout, stderr, remote }) => {
      if (code !== 0) throw new Error(`exit ${code}\n${stdout}\n${stderr}`);
      const handshake = remote.requests.find(
        (r) => r.path === "/api/remote/handshake",
      );
      if (bearerOf(handshake!) !== "cmr_from_env") {
        throw new Error("the environment must win over the saved config");
      }
    },
  );
});

test("an empty environment value counts as not set", async () => {
  await withByokWorktreeReview(
    {
      remoteFlags: false,
      env: { CM_REMOTE_HOST: "", CM_REMOTE_TOKEN: "" },
    },
    ({ code, stdout, remote }) => {
      if (code !== 2) throw new Error(`exit ${code}\n${stdout}`);
      const parsed = JSON.parse(stdout) as { error?: { code?: string } };
      if (parsed.error?.code !== "remote_not_configured") {
        throw new Error(stdout);
      }
      if (remote.requests.length !== 0)
        throw new Error("the server was contacted");
    },
  );
});

test("a key in the environment is never sent unless --remote-byok asked for it", async () => {
  await withByokWorktreeReview(
    {
      fakeRemote: {
        handshake: {
          features: ["byok"],
          byok: { policy: "allow" },
          ai: { provider: "openrouter" },
        },
      },
      // No --remote-byok and no remote-byok-default: the key only exists.
      env: { CM_REMOTE_BYOK: "sk-left-in-the-job-env" },
    },
    ({ code, stdout, stderr, remote }) => {
      if (code !== 0) throw new Error(`exit ${code}\n${stdout}\n${stderr}`);
      const submit = remote.requests.find(
        (r) => r.path === "/api/remote/reviews",
      );
      const body = submit?.body as { byok?: unknown } | undefined;
      if (body?.byok !== undefined) {
        throw new Error(
          `a key nobody asked to send was sent: ${JSON.stringify(body.byok)}`,
        );
      }
      if (JSON.stringify(submit?.body).includes("sk-left-in-the-job-env")) {
        throw new Error("the key reached the server");
      }
    },
  );
});
