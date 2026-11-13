/** A review of a clean tree says so once and stops.
 *
 * `exitWith` only sets the exit code. Without a return after it, a local
 * review of a clean tree called the model and printed a full report after
 * "No changes to review.", and a remote one did the handshake and submitted
 * an empty change that the server refused. Each run here must print one line,
 * or one JSON document with `--json`, exit 0, and reach no model and no
 * server. */
import { test } from "node:test";
import { commandOutput } from "../util/runtime.ts";
import { runtimeExecPath } from "../testing/runtime.ts";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";
import { startFakeRemote, writeCaCert } from "../testing/fake_remote.ts";
import { createLocalReviewSandbox } from "../testing/local_review_sandbox.ts";

type Mode = "local" | "remote";

async function reviewCleanTree(
  mode: Mode,
  json: boolean,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  modelCalls: number;
  serverCalls: string[];
}> {
  const sandbox = await createLocalReviewSandbox({ clean: true });
  const openrouter = await startFakeOpenRouter("success");
  const remote = await startFakeRemote({ repo: sandbox.repo });
  try {
    const ca = await writeCaCert(sandbox.home);
    const extra = [
      ...(json ? ["--json"] : []),
      ...(mode === "remote"
        ? ["--remote", `--remote-host=${remote.url}`, "--remote-token=cmr_x"]
        : []),
    ];
    const result = await commandOutput(runtimeExecPath(), {
      args: sandbox.reviewArgs(extra),
      cwd: sandbox.worktree,
      env: { ...sandbox.env(openrouter.url), NODE_EXTRA_CA_CERTS: ca },
    });
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      modelCalls: openrouter.requests.length,
      serverCalls: remote.requests.map((request) => request.path),
    };
  } finally {
    await openrouter.close();
    await remote.close();
    await sandbox.cleanup();
  }
}

for (const mode of ["local", "remote"] as const) {
  for (const json of [false, true]) {
    test(`a ${mode} review of a clean tree${json ? " with --json" : ""} prints one ${json ? "document" : "line"} and calls nothing`, async () => {
      const run = await reviewCleanTree(mode, json);
      const output = `exit ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
      const lines = run.stdout.trim().split("\n").filter(Boolean);
      if (run.code !== 0) throw new Error(output);
      if (lines.length !== 1) {
        throw new Error(`${lines.length} output lines, want one\n${output}`);
      }
      if (json) {
        const body = JSON.parse(lines[0]!) as {
          ok?: boolean;
          mode?: string;
          message?: string;
        };
        if (
          body.ok !== true ||
          body.mode !== mode ||
          body.message !== "No changes to review."
        ) {
          throw new Error(`unexpected document\n${output}`);
        }
      } else if (lines[0] !== "No changes to review.") {
        throw new Error(`unexpected line\n${output}`);
      }
      if (run.modelCalls !== 0) {
        throw new Error(`${run.modelCalls} model calls\n${output}`);
      }
      if (run.serverCalls.length !== 0) {
        throw new Error(
          `remote server called: ${run.serverCalls.join(", ")}\n${output}`,
        );
      }
    });
  }
}
