import {
  claimJob,
  getJob,
  getQueuedJobByKey,
  insertJob,
  listJobs,
  setJobStatus,
} from "../store/jobs.ts";
import { appendLog as storeAppendLog, listLogs } from "../store/job_logs.ts";
import { redact } from "../util/redact.ts";
import type { JobLogRow, JobRow } from "../store/rows.ts";

export type LogFn = (level: string, message: string) => void;

export type JobHandler = {
  run(job: JobRow, log: LogFn, signal: AbortSignal): Promise<void>;
  /** Called instead of `run` for a job found in `status = 'running'` at
   * boot: reconciles against whatever might already have happened rather
   * than blindly repeating side effects. Omit it when `run` is idempotent. */
  reconcile?(job: JobRow, log: LogFn): Promise<void>;
};

const handlers = new Map<string, JobHandler>();

export function registerHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

type Subscriber = (line: JobLogRow) => void;
const subscribers = new Map<string, Set<Subscriber>>();

export function subscribeToLogs(jobId: string, fn: Subscriber): () => void {
  const set = subscribers.get(jobId) ?? new Set();
  set.add(fn);
  subscribers.set(jobId, set);
  return () => set.delete(fn);
}

function log(jobId: string, level: string, message: string): void {
  const clean = redact(message);
  const seq = storeAppendLog(jobId, level, clean);
  const line: JobLogRow = {
    job_id: jobId,
    seq,
    at: new Date().toISOString(),
    level,
    message: clean,
  };
  for (const fn of subscribers.get(jobId) ?? []) fn(line);
}

export function getLogsSince(jobId: string, fromSeq = 0): JobLogRow[] {
  return listLogs(jobId, fromSeq);
}

export function enqueue(input: {
  type: string;
  repo: string;
  prNumber?: number;
  args?: unknown;
  deliveryId?: string;
  debounceMs?: number;
  queueKey?: string;
}): { id: string; debounced: boolean } {
  const queueKey = input.queueKey ??
    (input.type === "review" && input.prNumber !== undefined
      ? `review:${input.repo}:${input.prNumber}`
      : undefined);
  if (queueKey) {
    const existing = getQueuedJobByKey(queueKey);
    if (existing) {
      const age = Date.now() - Date.parse(existing.created_at);
      if (input.debounceMs && age < input.debounceMs) {
        return { id: existing.id, debounced: true };
      }
      const id = crypto.randomUUID();
      setJobStatus(existing.id, "canceled", { superseded_by: id });
      log(existing.id, "info", `superseded by ${id}`);
      insertJob({ ...input, id, queueKey });
      return { id, debounced: false };
    }
  }
  const id = crypto.randomUUID();
  insertJob({ ...input, id, queueKey });
  return { id, debounced: false };
}

const running = new Map<string, AbortController>();

async function runJob(job: JobRow): Promise<void> {
  const handler = handlers.get(job.type);
  const logFn: LogFn = (level, message) => log(job.id, level, message);
  if (!handler) {
    setJobStatus(job.id, "failed", {
      error: `no handler registered for job type ${job.type}`,
    });
    return;
  }
  const controller = new AbortController();
  running.set(job.id, controller);
  try {
    await handler.run(job, logFn, controller.signal);
    const status = controller.signal.aborted ? "canceled" : "done";
    setJobStatus(job.id, status);
    log(job.id, "status", status);
  } catch (error) {
    const status = controller.signal.aborted ? "canceled" : "failed";
    const message = error instanceof Error ? error.message : String(error);
    setJobStatus(
      job.id,
      status,
      controller.signal.aborted ? {} : { error: String(error) },
    );
    if (status === "failed") log(job.id, "error", message);
    log(job.id, "status", status);
  } finally {
    running.delete(job.id);
  }
}

export async function claimAndRun(): Promise<boolean> {
  // listJobs is newest-first. Reverse so we still pick the oldest queued
  // job that actually has a handler. Types without a handler stay queued
  // and do not block other types behind them.
  const oldestFirst = listJobs({ status: "queued" }).slice().reverse();
  for (const candidate of oldestFirst) {
    if (!handlers.has(candidate.type)) continue;
    if (!claimJob(candidate.id)) continue;
    await runJob(getJob(candidate.id)!);
    return true;
  }
  return false;
}

let workerTimer: ReturnType<typeof setInterval> | undefined;
let currentTick: Promise<void> = Promise.resolve();

// ponytail: poll every second rather than waking on enqueue. Simplest thing
// that works for job durations measured in tens of seconds to minutes; swap
// for an event-driven wakeup if sub-second latency ever matters here.
export function startWorkerLoop(intervalMs = 1000): void {
  if (workerTimer !== undefined) return;
  const tick = () => {
    currentTick = (async () => {
      while (await claimAndRun()) { /* drain */ }
    })();
    return currentTick;
  };
  workerTimer = setInterval(() => void tick(), intervalMs);
  void tick();
}

/** `clearInterval` alone only stops future polls; a poll already running
 * when shutdown starts could still be mid `claimAndRun()` after
 * `closeAppDb()` closes the connection under it, so this also awaits
 * whichever tick is in flight. Always `await` this before closing the
 * database. */
export async function stopWorkerLoop(): Promise<void> {
  if (workerTimer !== undefined) {
    clearInterval(workerTimer);
    workerTimer = undefined;
  }
  await currentTick.catch(() => {});
}

/** Cooperative: aborts a running job's `AbortSignal` if this process is
 * running it, or cancels it outright if it is merely queued. Returns false
 * if neither applies (already finished, or running in another process). */
export function cancel(jobId: string): boolean {
  const controller = running.get(jobId);
  if (controller) {
    controller.abort();
    return true;
  }
  const job = getJob(jobId);
  if (job?.status === "queued") {
    setJobStatus(jobId, "canceled");
    return true;
  }
  return false;
}

export async function recoverOrphans(): Promise<number> {
  const orphans = listJobs({ status: "running" });
  for (const job of orphans) {
    const handler = handlers.get(job.type);
    const logFn: LogFn = (level, message) => log(job.id, level, message);
    if (handler?.reconcile) {
      logFn(
        "info",
        "recovering after a restart: reconciling instead of rerunning",
      );
      try {
        await handler.reconcile(job, logFn);
        setJobStatus(job.id, "done");
      } catch (error) {
        setJobStatus(job.id, "failed", { error: String(error) });
      }
    } else {
      logFn("info", "recovering after a restart: requeued from the top");
      setJobStatus(job.id, "queued");
    }
  }
  return orphans.length;
}
