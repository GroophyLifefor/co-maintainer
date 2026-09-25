/** Error text contract tests (CORE-12).
 *
 * Each row of the plan's table is one case: the situation, the sentence the
 * user should read, and the exit code. The messages are asserted on their
 * substance (what broke, what to do) rather than the exact phrasing, so the
 * test survives copy edits but not a regression to the raw provider text.
 *
 * Where a case can only be produced by a real child process — a missing `gh`,
 * a 404, a rejected token — it runs through the CORE-03 harness, because that
 * is the only place the exit code and the merged output are observable.
 */
import { test } from "node:test";
import { createServer } from "node:http";
import { dirname } from "node:path";
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
import { openRouterError } from "../ai/openrouter.ts";
import { networkFailure, EXIT_RUNTIME, EXIT_USAGE } from "./error.ts";
import { createCliHarness, fakeGhBin } from "../testing/cli_harness.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function assertMessage(
  error: { message: string; hint?: string; exitCode: number },
  want: { message: RegExp; hint?: RegExp; exit: number },
): void {
  if (!want.message.test(error.message)) {
    throw new Error(`message was "${error.message}", wanted ${want.message}`);
  }
  if (want.hint) {
    if (!error.hint || !want.hint.test(error.hint)) {
      throw new Error(`hint was "${error.hint}", wanted ${want.hint}`);
    }
  }
  if (error.exitCode !== want.exit) {
    throw new Error(`exit ${error.exitCode}, wanted ${want.exit}`);
  }
}

test("error text: OpenRouter 401 tells the user how to replace the key", () => {
  assertMessage(
    openRouterError(
      "m",
      401,
      JSON.stringify({ error: { message: "User not found." } }),
    ),
    {
      message: /OpenRouter rejected the API key/,
      hint: /co-maintainer set --token/,
      exit: EXIT_USAGE,
    },
  );
});

test("error text: OpenRouter 400 for an unknown model names the model", () => {
  assertMessage(
    openRouterError(
      "nope/not-a-real-model",
      400,
      JSON.stringify({ error: { message: "model not found" } }),
    ),
    {
      message: /does not know the model nope\/not-a-real-model/,
      hint: /openrouter\.ai\/models/,
      exit: EXIT_USAGE,
    },
  );
});

test("error text: OpenRouter never leaks the raw body (user_id included)", () => {
  const error = openRouterError(
    "m",
    500,
    JSON.stringify({
      error: { message: "boom", user_id: "user_2abcSECRET" },
    }),
  );
  if (/user_id|user_2abcSECRET/.test(error.message + (error.hint ?? ""))) {
    throw new Error(`the raw body leaked: ${error.message} / ${error.hint}`);
  }
  if (error.exitCode !== EXIT_RUNTIME) {
    throw new Error(`exit ${error.exitCode}, wanted ${EXIT_RUNTIME}`);
  }
});

test("error text: a network failure names the host and the cause code", () => {
  const error = networkFailure(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      cause: { code: "ENOTFOUND" },
    },
  );
  if (!/Could not reach openrouter\.ai: ENOTFOUND/.test(error.message)) {
    throw new Error(`message was "${error.message}"`);
  }
  if (error.exitCode !== EXIT_RUNTIME) {
    throw new Error(`exit ${error.exitCode}, wanted ${EXIT_RUNTIME}`);
  }
});

test("error text: gh missing from PATH exits 2 with an install hint", async () => {
  const harness = await createCliHarness();
  try {
    const result = await harness.run({
      args: ["probe", "fixture/repo"],
      // A path that does not exist makes the spawn itself fail with ENOENT.
      env: { CM_GH_BIN: "gh-does-not-exist-xyz", CM_GH_SCRIPT: undefined },
    });
    const output = `${result.stdout}${result.stderr}`;
    if (!/GitHub CLI \(gh\) was not found/.test(output)) {
      throw new Error(`the missing gh was not explained:\n${output}`);
    }
    if (!/cli\.github\.com/.test(output)) {
      throw new Error(`the install hint is missing:\n${output}`);
    }
    if (result.code !== EXIT_USAGE) {
      throw new Error(`exit ${result.code}, wanted ${EXIT_USAGE}:\n${output}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test("error text: a 404 names owner/repo and exits 2", async () => {
  const harness = await createCliHarness();
  try {
    const result = await harness.run({
      args: ["probe", "fixture/repo"],
      ghMode: "notfound",
    });
    const output = `${result.stdout}${result.stderr}`;
    if (
      !/fixture\/repo was not found, or your GitHub account cannot read it/.test(
        output,
      )
    ) {
      throw new Error(`the 404 message is wrong:\n${output}`);
    }
    if (/gh api failed/.test(output)) {
      throw new Error(`the raw gh text survived:\n${output}`);
    }
    if (result.code !== EXIT_USAGE) {
      throw new Error(`exit ${result.code}, wanted ${EXIT_USAGE}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test("error text: gh with an empty stderr still says what failed", async () => {
  const harness = await createCliHarness();
  try {
    const result = await harness.run({
      args: ["probe", "fixture/repo"],
      ghMode: "empty-stderr",
    });
    const output = `${result.stdout}${result.stderr}`;
    // Before CORE-12 this collapsed to just the endpoint with no explanation.
    if (/\[error\] repos\/fixture\/repo\s*$/.test(output)) {
      throw new Error(
        `the empty-stderr message is just the endpoint:\n${output}`,
      );
    }
    if (!/repos\/fixture\/repo/.test(output)) {
      throw new Error(`the endpoint is not named:\n${output}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test("error text: a rejected remote token points at the dashboard", async () => {
  // A real server answering 401, because the rejection is what the CLI sees on
  // the wire and the message is built where the response is read.
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { code: "token_invalid", message: "invalid or missing token" },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  const root = await makeTempDir({ prefix: "cm-remote-401-" });
  try {
    const configPath = `${root}/config.json`;
    await writeTextFile(
      configPath,
      `${JSON.stringify(
        {
          remoteHost: url,
          remoteToken: "bad-token",
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
    // The remote path needs a reviewable local revision, so a git worktree with
    // one committed change is built the same way the exit tests do it.
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
        "--json",
        "--disable-codegraph",
      ]),
      cwd: worktree,
      env: {
        ...envToObject(),
        CM_CONFIG_PATH: configPath,
        CM_REPOS_DIR: `${root}/repos`,
        CM_GH_BIN: fakeGhBin().command,
        CM_GH_SCRIPT: fakeGhBin().script,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
    if (!/rejected the remote review token/.test(output)) {
      throw new Error(`the token rejection was not explained:\n${output}`);
    }
    if (!/Remote review tokens/.test(output)) {
      throw new Error(`the dashboard hint is missing:\n${output}`);
    }
  } finally {
    await remove(root, { recursive: true });
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
});
