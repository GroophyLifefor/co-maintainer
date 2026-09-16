import { readConfig } from "../config.ts";
import {
  claimJob,
  getJob,
  getQueuedJobByKey,
  getRunningJobByKey,
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
  reconcile?(
    job: JobRow,
    log: LogFn,
  ): Promise<"done" | "canceled" | void>;
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
      setJobStatus(existing.id, "canceled", {
        superseded_by: id,
        cancel_reason: "superseded",
      });
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
const pendingCancelReason = new Map<string, string>();

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
    const cancelReason = pendingCancelReason.get(job.id);
    setJobStatus(
      job.id,
      status,
      cancelReason ? { cancel_reason: cancelReason } : {},
    );
    log(job.id, "status", status);
  } catch (error) {
    const status = controller.signal.aborted ? "canceled" : "failed";
    const message = error instanceof Error ? error.message : String(error);
    const cancelReason = pendingCancelReason.get(job.id);
    setJobStatus(
      job.id,
      status,
      controller.signal.aborted
        ? (cancelReason ? { cancel_reason: cancelReason } : {})
        : { error: String(error) },
    );
    if (status === "failed") log(job.id, "error", message);
    log(job.id, "status", status);
  } finally {
    running.delete(job.id);
    pendingCancelReason.delete(job.id);
  }
}

function claimNextEligible(): JobRow | undefined {
  const oldestFirst = listJobs({ status: "queued" }).slice().reverse();
  for (const candidate of oldestFirst) {
    if (!handlers.has(candidate.type)) continue;
    if (candidate.queue_key) {
      const busy = getRunningJobByKey(candidate.queue_key);
      if (busy) continue;
    }
    if (!claimJob(candidate.id)) continue;
    return getJob(candidate.id);
  }
  return undefined;
}

export async function claimAndRun(): Promise<boolean> {
  const job = claimNextEligible();
  if (!job) return false;
  await runJob(job);
  return true;
}

const inFlight = new Set<Promise<void>>();
let workerTimer: ReturnType<typeof setInterval> | undefined;

function tick(): void {
  const limit = readConfig().maxConcurrentJobs;
  while (!limit || inFlight.size < limit) {
    const job = claimNextEligible();
    if (!job) break;
    const p = runJob(job).finally(() => {
      inFlight.delete(p);
    });
    inFlight.add(p);
  }
}

export function startWorkerLoop(intervalMs = 1000): void {
  if (workerTimer !== undefined) return;
  workerTimer = setInterval(() => tick(), intervalMs);
  tick();
}

export async function stopWorkerLoop(): Promise<void> {
  if (workerTimer !== undefined) {
    clearInterval(workerTimer);
    workerTimer = undefined;
  }
  await Promise.allSettled([...inFlight]);
}

/** Cooperative: aborts a running job's `AbortSignal` if this process is
 * running it, or cancels it outright if it is merely queued. Returns false
 * if neither applies (already finished, or running in another process). */
export function cancel(
  jobId: string,
  reason = "dashboard_canceled",
): boolean {
  const controller = running.get(jobId);
  if (controller) {
    pendingCancelReason.set(jobId, reason);
    controller.abort();
    return true;
  }
  const job = getJob(jobId);
  if (job?.status === "queued") {
    setJobStatus(jobId, "canceled", { cancel_reason: reason });
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
        const outcome = await handler.reconcile(job, logFn);
        setJobStatus(
          job.id,
          outcome === "canceled" ? "canceled" : "done",
          outcome === "canceled"
            ? { cancel_reason: "server_restarted" }
            : {},
        );
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
