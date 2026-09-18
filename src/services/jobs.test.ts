import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { getJob, getRunningJobByKey, listJobs } from "../store/jobs.ts";
import { writeUserConfig } from "../config.ts";
import {
  cancel,
  claimAndRun,
  enqueue,
  getLogsSince,
  recoverOrphans,
  registerHandler,
  startWorkerLoop,
  stopWorkerLoop,
  subscribeToLogs,
} from "./jobs.ts";
import { insertJob } from "../store/jobs.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { test } from "node:test";

async function withTempDb(fn: () => Promise<void>): Promise<void> {
  const original = getEnv("CM_APP_DB");
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
  }
}

test("enqueue supersedes an existing queued job for the same PR", async () => {
  await withTempDb(async () => {
    const first = enqueue({ type: "review", repo: "a/b", prNumber: 1 });
    const second = enqueue({ type: "review", repo: "a/b", prNumber: 1 });
    if (first.id === second.id) throw new Error("expected a fresh job");
    const oldJob = getJob(first.id);
    if (oldJob?.status !== "canceled" || oldJob.superseded_by !== second.id) {
      throw new Error("the old job was not marked superseded");
    }
    if (getJob(second.id)?.status !== "queued") {
      throw new Error("the new job is not queued");
    }
  });
});

test("enqueue within the debounce window collapses into the existing job", async () => {
  await withTempDb(async () => {
    const first = enqueue({
      type: "review",
      repo: "a/b",
      prNumber: 1,
      debounceMs: 60_000,
    });
    const second = enqueue({
      type: "review",
      repo: "a/b",
      prNumber: 1,
      debounceMs: 60_000,
    });
    if (first.id !== second.id || !second.debounced) {
      throw new Error(
        "a rapid second enqueue created a new job instead of collapsing",
      );
    }
    if (getJob(first.id)?.status !== "queued") {
      throw new Error("the collapsed job should still be queued");
    }
  });
});

test("reply jobs do not supersede a queued review for the same PR", async () => {
  await withTempDb(async () => {
    const review = enqueue({ type: "review", repo: "a/b", prNumber: 1 });
    const reply = enqueue({
      type: "reply",
      repo: "a/b",
      prNumber: 1,
      queueKey: "reply:a/b:review_comment:99",
    });
    if (
      review.id === reply.id ||
      getJob(review.id)?.status !== "queued" ||
      getJob(reply.id)?.status !== "queued"
    ) {
      throw new Error("reply and review jobs collided");
    }
  });
});

test("claimAndRun runs the registered handler and appends redacted logs", async () => {
  await withTempDb(async () => {
    const seen: string[] = [];
    registerHandler("test-run", {
      async run(job, log) {
        log("info", `running ${job.id} with token ghp_abcdefghijklmnopqrst`);
        seen.push(job.id);
      },
    });
    const { id } = enqueue({ type: "test-run", repo: "a/b" });
    const ran = await claimAndRun();
    if (!ran) throw new Error("claimAndRun found nothing to run");
    if (seen[0] !== id) {
      throw new Error("the handler did not receive the claimed job");
    }
    if (getJob(id)?.status !== "done") {
      throw new Error("job did not finish as done");
    }
    const lines = getLogsSince(id);
    // The handler's own line plus the queue's own "status: done" line
    // (services/jobs.ts always logs the terminal transition, so a live
    // subscriber can detect completion even if the handler logged nothing
    // as its very last act).
    if (lines.length !== 2) {
      throw new Error(`expected 2 log lines, got ${lines.length}`);
    }
    if (lines[0].message.includes("ghp_")) {
      throw new Error("a token leaked into the stored log line unredacted");
    }
  });
});

test("a failing handler marks the job failed with the error message", async () => {
  await withTempDb(async () => {
    registerHandler("test-fail", {
      async run() {
        throw new Error("boom");
      },
    });
    const { id } = enqueue({ type: "test-fail", repo: "a/b" });
    await claimAndRun();
    const job = getJob(id);
    if (job?.status !== "failed" || job.error !== "Error: boom") {
      throw new Error(`unexpected job state: ${JSON.stringify(job)}`);
    }
    const lines = getLogsSince(id);
    if (!lines.some((line) => line.message === "boom")) {
      throw new Error("the error never reached job_logs");
    }
  });
});

test("cancel aborts a running job cooperatively", async () => {
  await withTempDb(async () => {
    let observedAborted = false;
    registerHandler("test-cancel", {
      run(_job, _log, signal) {
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            observedAborted = true;
            resolve();
          });
        });
      },
    });
    const { id } = enqueue({ type: "test-cancel", repo: "a/b" });
    const runPromise = claimAndRun();
    // Give claimAndRun a tick to claim and start the handler before we cancel.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const canceled = cancel(id);
    await runPromise;
    if (!canceled) {
      throw new Error("cancel() reported it found nothing to cancel");
    }
    if (!observedAborted) {
      throw new Error("the handler never saw the abort signal");
    }
    if (getJob(id)?.status !== "canceled") {
      throw new Error(`expected canceled, got ${getJob(id)?.status}`);
    }
  });
});

test("cancel on a merely queued job marks it canceled without running it", async () => {
  await withTempDb(async () => {
    const { id } = enqueue({ type: "unused", repo: "a/b" });
    if (!cancel(id)) throw new Error("cancel() did not find the queued job");
    if (getJob(id)?.status !== "canceled") {
      throw new Error("queued job was not canceled");
    }
  });
});

test("orphan recovery reconciles when a handler provides it", async () => {
  await withTempDb(async () => {
    let reconciled = false;
    registerHandler("test-reconcile", {
      async run() {},
      async reconcile(job) {
        reconciled = true;
        if (job.status !== "running") {
          throw new Error("reconcile did not see the orphaned job");
        }
      },
    });
    insertJob({ id: "orphan-1", type: "test-reconcile", repo: "a/b" });
    // Simulate a crash: the job is stuck in "running" with no process behind it.
    const { setJobStatus } = await import("../store/jobs.ts");
    setJobStatus("orphan-1", "running");

    const touched = await recoverOrphans();
    if (touched !== 1) throw new Error(`expected 1 orphan, touched ${touched}`);
    if (!reconciled) throw new Error("reconcile was never called");
    if (getJob("orphan-1")?.status !== "done") {
      throw new Error("reconciled job was not marked done");
    }
  });
});

test("orphan recovery requeues a job whose type has no reconcile hook", async () => {
  await withTempDb(async () => {
    registerHandler("test-no-reconcile", { async run() {} });
    insertJob({ id: "orphan-2", type: "test-no-reconcile", repo: "a/b" });
    const { setJobStatus } = await import("../store/jobs.ts");
    setJobStatus("orphan-2", "running");

    await recoverOrphans();
    if (getJob("orphan-2")?.status !== "queued") {
      throw new Error(
        "a type with no reconcile hook should be requeued from the top",
      );
    }
  });
});

test("logs are resumable: getLogsSince(fromSeq) and live subscribers both work", async () => {
  await withTempDb(async () => {
    const received: string[] = [];
    registerHandler("test-logs", {
      async run(_job, log) {
        log("info", "line one");
        log("info", "line two");
      },
    });
    const { id } = enqueue({ type: "test-logs", repo: "a/b" });
    const unsubscribe = subscribeToLogs(id, (line) =>
      received.push(line.message),
    );
    await claimAndRun();
    unsubscribe();
    // line one, line two, and the queue's own final "status: done" line.
    if (received.length !== 3) {
      throw new Error(
        `live subscriber received ${received.length} lines, expected 3`,
      );
    }
    const all = getLogsSince(id);
    if (all.length !== 3) throw new Error("getLogsSince(0) missed a line");
    const resumed = getLogsSince(id, all[0].seq);
    if (resumed.length !== 2 || resumed[0].message !== "line two") {
      throw new Error(
        "resuming from the first seq did not skip exactly the first line",
      );
    }
  });
});

test("claimAndRun skips a queued type with no handler so it does not block others", async () => {
  await withTempDb(async () => {
    const seen: string[] = [];
    registerHandler("test-skip-unknown", {
      async run(job) {
        seen.push(job.id);
      },
    });
    const review = enqueue({ type: "review", repo: "a/b", prNumber: 1 });
    const runnable = enqueue({ type: "test-skip-unknown", repo: "a/b" });
    const ran = await claimAndRun();
    if (!ran || seen[0] !== runnable.id) {
      throw new Error("did not run the job whose type has a handler");
    }
    if (getJob(review.id)?.status !== "queued") {
      throw new Error("the handler-less review job should stay queued");
    }
  });
});

test("jobs: same key waits while a review is already running", async () => {
  await withTempDb(async () => {
    let firstRunning = false;
    registerHandler("test-same-key", {
      run(_job, _log, signal) {
        return new Promise<void>((resolve) => {
          firstRunning = true;
          signal.addEventListener("abort", () => resolve());
        });
      },
    });
    const key = "review:a/b:1";
    insertJob({
      id: "running-1",
      type: "test-same-key",
      repo: "a/b",
      queueKey: key,
    });
    const { setJobStatus } = await import("../store/jobs.ts");
    setJobStatus("running-1", "running");
    const { id: queuedId } = enqueue({
      type: "test-same-key",
      repo: "a/b",
      queueKey: key,
    });
    const ran = await claimAndRun();
    if (ran) throw new Error("should not claim while same key is running");
    if (getJob(queuedId)?.status !== "queued") {
      throw new Error("second job should stay queued");
    }
    if (!getRunningJobByKey(key)) {
      throw new Error("running job should still be marked running");
    }
    if (firstRunning) throw new Error("queued job should not have started");
  });
});

test("jobs: global limit caps concurrent workers", async () => {
  const originalConfig = getEnv("CM_CONFIG_PATH");
  setEnv("CM_CONFIG_PATH", `${tempDirSync()}/config.json`);
  await writeUserConfig({ maxConcurrentJobs: 1 });
  await withTempDb(async () => {
    let active = 0;
    let peak = 0;
    registerHandler("test-limit", {
      async run() {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active--;
      },
    });
    enqueue({ type: "test-limit", repo: "a/b" });
    enqueue({ type: "test-limit", repo: "a/b" });
    try {
      startWorkerLoop(10);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (listJobs({ status: "done" }).length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await stopWorkerLoop();
    }
    if (peak > 1) throw new Error(`peak concurrency was ${peak}, expected 1`);
  });
  if (originalConfig === undefined) deleteEnv("CM_CONFIG_PATH");
  else setEnv("CM_CONFIG_PATH", originalConfig);
});

test("jobs: stop waits all in flight", async () => {
  await withTempDb(async () => {
    let finished = 0;
    registerHandler("test-stop-wait", {
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        finished++;
      },
    });
    enqueue({ type: "test-stop-wait", repo: "a/b" });
    enqueue({ type: "test-stop-wait", repo: "a/b" });
    startWorkerLoop(5);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await stopWorkerLoop();
    if (finished < 2) {
      throw new Error(
        `stopWorkerLoop returned before jobs finished (${finished})`,
      );
    }
  });
});

test("cancel on a running job records dashboard_canceled", async () => {
  await withTempDb(async () => {
    registerHandler("test-cancel-reason", {
      run(_job, _log, signal) {
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
        });
      },
    });
    const { id } = enqueue({ type: "test-cancel-reason", repo: "a/b" });
    const runPromise = claimAndRun();
    await new Promise((resolve) => setTimeout(resolve, 10));
    cancel(id, "dashboard_canceled");
    await runPromise;
    if (getJob(id)?.cancel_reason !== "dashboard_canceled") {
      throw new Error("cancel_reason was not stored");
    }
  });
});

test("startWorkerLoop drains a queued job without anyone calling claimAndRun by hand", async () => {
  await withTempDb(async () => {
    let ran = false;
    registerHandler("test-worker-loop", {
      run() {
        ran = true;
        return Promise.resolve();
      },
    });
    enqueue({ type: "test-worker-loop", repo: "a/b" });
    try {
      startWorkerLoop(20);
      const deadline = Date.now() + 2000;
      while (!ran && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await stopWorkerLoop();
    }
    if (!ran) throw new Error("the worker loop never picked up the job");
  });
});
