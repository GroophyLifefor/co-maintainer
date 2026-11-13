/** Ctrl-C stops a local review.
 *
 * The signal handler only set the exit code. The review then waited for the
 * model, printed its full report after the "aborted" one and exited with the
 * report's code instead of 3. A real child process and a real signal are the
 * only honest way to see this, so the test runs `main.ts` and sends SIGINT
 * while the model call is in flight.
 */
import { spawn } from "node:child_process";
import { test } from "node:test";
import { readDir, runtimeExecPath } from "../testing/runtime.ts";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";
import { createLocalReviewSandbox } from "../testing/local_review_sandbox.ts";

async function until(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function lockFiles(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of readDir(dir)) names.push(entry.name);
  } catch {
    // No locks directory: no lock.
  }
  return names;
}

const chatCalls = (requests: Record<string, unknown>[]) =>
  requests.filter((body) => Array.isArray(body.messages)).length;

for (const signal of ["SIGINT", "SIGTERM"] as const)
  test(
    `${signal} during the model call stops a local review with one output and exit 3`,
    { skip: process.platform === "win32" && "POSIX signals only" },
    async () => {
      const sandbox = await createLocalReviewSandbox();
      // The answer comes well after the signal. A review that keeps going after
      // Ctrl-C gets it, then prints a second document and a different code.
      const server = await startFakeOpenRouter("success", {
        chatDelayMs: 3000,
      });
      const child = spawn(runtimeExecPath(), sandbox.reviewArgs(["--json"]), {
        cwd: sandbox.worktree,
        env: sandbox.env(server.url) as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
      const exited = new Promise<{ code: number | null; at: number }>(
        (resolve) =>
          child.on("close", (code) => resolve({ code, at: Date.now() })),
      );
      try {
        await until("the review's model call", () => {
          if (child.exitCode !== null) {
            throw new Error(`review exited early:\n${stdout}\n${stderr}`);
          }
          return chatCalls(server.requests) > 0;
        });
        const sentAt = Date.now();
        child.kill(signal);
        const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
        const { code, at } = await exited;
        clearTimeout(timeout);
        const output = `stdout:\n${stdout}\nstderr:\n${stderr}`;
        if (code === null) {
          throw new Error(`the review did not stop after Ctrl-C\n${output}`);
        }
        const documents = stdout.trim().split("\n").filter(Boolean);
        if (documents.length !== 1) {
          throw new Error(`${documents.length} outputs, want one\n${output}`);
        }
        const body = JSON.parse(documents[0]!) as {
          error?: { code?: string };
          exitCode?: number;
        };
        if (body.error?.code !== "aborted" || body.exitCode !== 3) {
          throw new Error(`not the aborted document\n${output}`);
        }
        if (code !== 3) throw new Error(`exit ${code}, want 3\n${output}`);
        // It stops at once, not when the model's answer comes in.
        if (at - sentAt > 2500) {
          throw new Error(`stopped ${at - sentAt}ms after Ctrl-C\n${output}`);
        }
        const locks = await lockFiles(sandbox.locksDir);
        if (locks.length) {
          throw new Error(`lock left behind: ${locks.join(", ")}\n${output}`);
        }
        // Wait out the held answer: a review still running would now send its
        // next call.
        await new Promise((resolve) => setTimeout(resolve, 3500));
        if (chatCalls(server.requests) !== 1) {
          throw new Error(
            `${chatCalls(server.requests)} model calls, want 1\n${output}`,
          );
        }
      } finally {
        child.kill("SIGKILL");
        await server.close();
        await sandbox.cleanup();
      }
    },
  );
