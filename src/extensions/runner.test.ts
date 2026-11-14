/** The runner: when each extension starts, what a failure does to the ones
 * waiting on it, retries, the timeout, the process group kill and a restart. */
import { test } from "node:test";
import {
  deleteEnv,
  getEnv,
  readTextFile,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import type { ExtensionRegistration } from "./registry.ts";
import { runExtensions, type ExtensionResult } from "./runner.ts";
import {
  openRunFolder,
  removeRunFolder,
  writeReviewResult,
  type RunFolder,
} from "./run_folder.ts";
import { isProcessAlive } from "../util/runtime.ts";

const posixOnly = { skip: process.platform === "win32" };

const OK = JSON.stringify({
  schemaVersion: 1,
  name: "t",
  status: "ok",
  verdict: "comment",
});

function registration(
  overrides: Partial<ExtensionRegistration>,
): ExtensionRegistration {
  return {
    name: "x",
    command: `echo '${OK}'`,
    repos: "*",
    parallelism: true,
    priority: 0,
    failFast: false,
    retryOnFailTimes: 0,
    maxRequestedRetries: 3,
    timeoutSeconds: 20,
    ...overrides,
  };
}

async function withFolder(
  fn: (folder: RunFolder, dir: string) => Promise<void>,
  runId = crypto.randomUUID(),
): Promise<void> {
  const original = getEnv("CM_CONFIG_PATH");
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  try {
    const folder = await openRunFolder({
      runId,
      owner: "serve",
      details: {
        schemaVersion: 1,
        reviewType: "pr",
        repo: "acme/widgets",
        prNumber: 7,
        branch: null,
        workdir: "",
        headSha: "h",
        baseSha: "b",
        scope: "whole-pr",
        sinceCommit: null,
        trigger: "synchronize",
        round: 1,
      },
      diff: "diff --git a/x b/x\n",
    });
    await fn(folder, dir);
    await removeRunFolder(folder);
  } finally {
    if (original === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", original);
  }
}

function deferred(): {
  promise: Promise<boolean>;
  resolve: (v: boolean) => void;
} {
  let resolve!: (v: boolean) => void;
  const promise = new Promise<boolean>((done) => (resolve = done));
  return { promise, resolve };
}

function byName(results: ExtensionResult[]): Map<string, ExtensionResult> {
  return new Map(results.map((result) => [result.name, result]));
}

test(
  "parallel extensions start with the review, the rest wait for their target",
  posixOnly,
  async () => {
    await withFolder(async (folder, dir) => {
      const log = `${dir}/order.log`;
      const write = (name: string) =>
        `echo ${name} {{review_result_path}} >> '${log}'; echo '${OK}'`;
      const review = deferred();
      const running = runExtensions({
        registrations: [
          registration({ name: "early", command: write("early") }),
          registration({
            name: "after-early",
            command: write("after-early"),
            runAfter: "early",
          }),
          registration({
            name: "serial",
            command: write("serial"),
            parallelism: false,
          }),
          registration({
            name: "after-review",
            command: write("after-review"),
            runAfter: "review",
          }),
        ],
        folder,
        reviewDone: review.promise,
        rerunOnRestart: () => true,
      });
      // The review is still running: only the parallel chain may have run.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const before = await readTextFile(log);
      if (before.includes("serial") || before.includes("after-review")) {
        throw new Error(`started before the review finished:\n${before}`);
      }
      if (!before.includes("early \n") || !before.includes("after-early \n")) {
        throw new Error(
          `the parallel chain did not run, or saw a review path:\n${before}`,
        );
      }
      await writeReviewResult(folder, { schemaVersion: 1, findings: [] });
      review.resolve(true);
      const results = byName(await running);
      for (const name of ["early", "after-early", "serial", "after-review"]) {
        if (results.get(name)?.status !== "ok") {
          throw new Error(`${name}: ${JSON.stringify(results.get(name))}`);
        }
      }
      const after = await readTextFile(log);
      if (!after.includes(`after-review ${folder.reviewResultPath}`)) {
        throw new Error(
          `the review path was not given after the review:\n${after}`,
        );
      }
    });
  },
);

test(
  "extensions ready together start in priority order, ties in registration order",
  posixOnly,
  async () => {
    await withFolder(async (folder) => {
      const done = deferred();
      done.resolve(true);
      await runExtensions({
        registrations: [
          registration({ name: "p0-first" }),
          registration({ name: "p3", priority: 3 }),
          registration({ name: "p0-second" }),
          registration({ name: "p1", priority: 1 }),
        ],
        folder,
        reviewDone: done.promise,
        rerunOnRestart: () => true,
      });
      const state = JSON.parse(
        await readTextFile(`${folder.dir}/state.json`),
      ) as {
        started: string[];
      };
      if (state.started.join() !== "p3,p1,p0-first,p0-second") {
        throw new Error(state.started.join());
      }
    });
  },
);

test(
  "a fail-fast failure skips what waits on it and nothing else",
  posixOnly,
  async () => {
    await withFolder(async (folder) => {
      const done = deferred();
      done.resolve(true);
      const results = byName(
        await runExtensions({
          registrations: [
            registration({ name: "strict", command: "exit 1", failFast: true }),
            registration({ name: "after-strict", runAfter: "strict" }),
            registration({ name: "loose", command: "exit 1" }),
            registration({ name: "after-loose", runAfter: "loose" }),
            registration({ name: "unrelated" }),
            registration({ name: "orphan", runAfter: "missing" }),
            registration({
              name: "skipper",
              command: `echo '{"schemaVersion":1,"name":"s","status":"skipped","reason":"not mine"}'`,
            }),
            registration({ name: "after-skipper", runAfter: "skipper" }),
          ],
          folder,
          reviewDone: done.promise,
          rerunOnRestart: () => true,
        }),
      );
      const want: Record<string, string> = {
        strict: "failed",
        "after-strict": "skipped",
        loose: "failed",
        "after-loose": "ok",
        unrelated: "ok",
        orphan: "skipped",
        skipper: "skipped",
        "after-skipper": "skipped",
      };
      for (const [name, status] of Object.entries(want)) {
        if (results.get(name)?.status !== status) {
          throw new Error(`${name}: ${JSON.stringify(results.get(name))}`);
        }
      }
      if (!results.get("strict")?.reason?.includes("exited with code 1")) {
        throw new Error(String(results.get("strict")?.reason));
      }
      if (
        !results.get("orphan")?.reason?.includes("does not run for this review")
      ) {
        throw new Error(String(results.get("orphan")?.reason));
      }
    });
  },
);

test(
  "a bad response is retried, a requested retry is honoured up to its limit",
  posixOnly,
  async () => {
    await withFolder(async (folder, dir) => {
      const counter = `${dir}/count`;
      await writeTextFile(counter, "");
      // Prints garbage twice, then a valid response.
      const flaky = `echo x >> '${counter}'; if [ $(wc -l < '${counter}') -lt 3 ]; then echo broken; else echo '${OK}'; fi`;
      const retry = `echo '{"schemaVersion":1,"name":"r","status":"retry","reason":"busy","retryAfterSeconds":120}'`;
      const waits: number[] = [];
      const done = deferred();
      done.resolve(true);
      const results = byName(
        await runExtensions({
          registrations: [
            registration({
              name: "flaky",
              command: flaky,
              retryOnFailTimes: 2,
            }),
            registration({
              name: "retry",
              command: retry,
              maxRequestedRetries: 2,
            }),
            registration({ name: "no-retries", command: "echo broken" }),
          ],
          folder,
          reviewDone: done.promise,
          rerunOnRestart: () => true,
          sleep: async (ms) => {
            waits.push(ms);
          },
        }),
      );
      const flakyResult = results.get("flaky")!;
      if (flakyResult.status !== "ok" || flakyResult.attempts !== 3) {
        throw new Error(JSON.stringify(flakyResult));
      }
      const retryResult = results.get("retry")!;
      if (
        retryResult.status !== "failed" ||
        retryResult.attempts !== 3 ||
        !retryResult.reason?.includes("more than 2 times. Last reason: busy")
      ) {
        throw new Error(JSON.stringify(retryResult));
      }
      if (waits.join() !== "120000,120000") throw new Error(waits.join());
      if (results.get("no-retries")?.attempts !== 1) {
        throw new Error("a registration with no retries ran twice");
      }
    });
  },
);

test(
  "a timeout kills the whole process group and is Failed",
  posixOnly,
  async () => {
    await withFolder(async (folder, dir) => {
      const pidFile = `${dir}/child.pid`;
      // The background child ignores SIGTERM, so only the SIGKILL after the
      // grace period ends it.
      const command = `(trap '' TERM; exec sleep 30) & echo $! > '${pidFile}'; wait`;
      const done = deferred();
      done.resolve(true);
      const started = performance.now();
      const [result] = await runExtensions({
        registrations: [
          registration({ name: "slow", command, timeoutSeconds: 0.4 }),
        ],
        folder,
        reviewDone: done.promise,
        rerunOnRestart: () => true,
        killGraceMs: 200,
      });
      if (
        result?.status !== "failed" ||
        result.reason !== "timed out after 0.4s"
      ) {
        throw new Error(JSON.stringify(result));
      }
      if (performance.now() - started > 10_000)
        throw new Error("it waited for sleep 30");
      const pid = Number((await readTextFile(pidFile)).trim());
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (isProcessAlive(pid))
        throw new Error(`child ${pid} survived the kill`);
    });
  },
);

test(
  "a cancel stops the running extensions and starts no more",
  posixOnly,
  async () => {
    await withFolder(async (folder) => {
      const controller = new AbortController();
      const review = deferred();
      const running = runExtensions({
        registrations: [
          registration({ name: "long", command: "sleep 30" }),
          registration({ name: "later", runAfter: "review" }),
        ],
        folder,
        reviewDone: review.promise,
        signal: controller.signal,
        rerunOnRestart: () => true,
        killGraceMs: 200,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      controller.abort();
      review.resolve(false);
      const results = byName(await running);
      if (results.get("long")?.reason !== "the review was cancelled") {
        throw new Error(JSON.stringify(results.get("long")));
      }
      if (results.get("later")?.status !== "failed") {
        throw new Error(JSON.stringify(results.get("later")));
      }
    });
  },
);

test(
  "after a restart, an extension cut off mid-run reruns unless told not to",
  posixOnly,
  async () => {
    const runId = crypto.randomUUID();
    await withFolder(async (folder) => {
      await writeTextFile(
        `${folder.dir}/state.json`,
        JSON.stringify({
          started: ["keep-going", "stop", "done-before"],
          finished: ["done-before"],
        }),
      );
      const again = await openRunFolder({
        runId,
        owner: "serve",
        details: folder.details,
        diff: "",
      });
      if (!again.restarted) throw new Error("the restart was not noticed");
      const done = deferred();
      done.resolve(true);
      const results = byName(
        await runExtensions({
          registrations: [
            registration({ name: "keep-going" }),
            registration({ name: "stop", rerunOnRestart: false }),
            registration({ name: "never-started", rerunOnRestart: false }),
            registration({ name: "done-before", rerunOnRestart: false }),
          ],
          folder: again,
          reviewDone: done.promise,
          rerunOnRestart: (entry) => entry.rerunOnRestart ?? true,
        }),
      );
      if (results.get("keep-going")?.status !== "ok")
        throw new Error("keep-going");
      if (results.get("never-started")?.status !== "ok") {
        throw new Error("an extension that never started was failed");
      }
      if (results.get("done-before")?.status !== "ok") {
        throw new Error("an extension that had finished was called cut off");
      }
      const stop = results.get("stop");
      if (stop?.status !== "failed" || !stop.reason?.includes("restarted")) {
        throw new Error(JSON.stringify(stop));
      }
    }, runId);
  },
);

test(
  "details are capped at 128 KB: the first and last 64 KB with a marker",
  posixOnly,
  async () => {
    await withFolder(async (folder) => {
      const done = deferred();
      done.resolve(true);
      // 300 KB of output, then a broken response.
      const command = `i=0; while [ $i -lt 3000 ]; do printf '%0100d\\n' $i >&2; i=$((i+1)); done; echo broken`;
      const [result] = await runExtensions({
        registrations: [registration({ name: "loud", command })],
        folder,
        reviewDone: done.promise,
        rerunOnRestart: () => true,
      });
      const details = result?.details ?? "";
      if (!details.includes("output cut here")) throw new Error("no marker");
      if (details.length > 132 * 1024)
        throw new Error(`${details.length} chars`);
      if (!details.trimEnd().endsWith("broken"))
        throw new Error("the tail was lost");
      if (!details.startsWith("exit code: 0"))
        throw new Error(details.slice(0, 40));
    });
  },
);
