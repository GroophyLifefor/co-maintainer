import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { getJob } from "../store/jobs.ts";
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

async function withTempDb(fn: () => Promise<void>): Promise<void> {
  const original = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_APP_DB", `${Deno.makeTempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", original);
  }
}

Deno.test("enqueue supersedes an existing queued job for the same PR", async () => {
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

Deno.test("enqueue within the debounce window collapses into the existing job", async () => {
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

Deno.test("reply jobs do not supersede a queued review for the same PR", async () => {
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

Deno.test("claimAndRun runs the registered handler and appends redacted logs", async () => {
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

Deno.test("a failing handler marks the job failed with the error message", async () => {
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

Deno.test("cancel aborts a running job cooperatively", async () => {
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

Deno.test("cancel on a merely queued job marks it canceled without running it", async () => {
  await withTempDb(async () => {
    const { id } = enqueue({ type: "unused", repo: "a/b" });
    if (!cancel(id)) throw new Error("cancel() did not find the queued job");
    if (getJob(id)?.status !== "canceled") {
      throw new Error("queued job was not canceled");
    }
  });
});

Deno.test("orphan recovery reconciles when a handler provides it", async () => {
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

Deno.test("orphan recovery requeues a job whose type has no reconcile hook", async () => {
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

Deno.test("logs are resumable: getLogsSince(fromSeq) and live subscribers both work", async () => {
  await withTempDb(async () => {
    const received: string[] = [];
    registerHandler("test-logs", {
      async run(_job, log) {
        log("info", "line one");
        log("info", "line two");
      },
    });
    const { id } = enqueue({ type: "test-logs", repo: "a/b" });
    const unsubscribe = subscribeToLogs(
      id,
      (line) => received.push(line.message),
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

Deno.test("claimAndRun skips a queued type with no handler so it does not block others", async () => {
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

Deno.test("startWorkerLoop drains a queued job without anyone calling claimAndRun by hand", async () => {
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
