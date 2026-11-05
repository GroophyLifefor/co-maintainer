import { AsyncLocalStorage } from "node:async_hooks";
import { isAppDbOpen } from "../store/app_db.ts";
import { appendLog, listLogs } from "../store/job_logs.ts";
import { listJobs } from "../store/jobs.ts";
import type { JobLogRow, JobRow } from "../store/rows.ts";

export type RateLimitWaitService = "openrouter" | "github";

export type RateLimitWait = {
  jobId: string;
  service: RateLimitWaitService;
  stage: string;
  reason: string;
  seconds: number;
  at: string;
};

export type RateLimitWaitSummary = {
  count: number;
  totalSeconds: number;
};

export type RateLimitWaitInput = {
  jobId?: string;
  service: RateLimitWaitService;
  stage: string;
  reason: string;
  seconds: number;
};

export const RATE_LIMIT_WAIT_LOG_TYPE = "rate_limit_wait";

const jobStorage = new AsyncLocalStorage<string>();

export function currentRateLimitJobId(): string | undefined {
  return jobStorage.getStore();
}

export function withRateLimitJob<T>(
  jobId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return jobStorage.run(jobId, fn);
}

function parseWait(jobId: string, line: JobLogRow): RateLimitWait | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.message);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.type !== RATE_LIMIT_WAIT_LOG_TYPE) return undefined;
  const service = record.service;
  if (service !== "openrouter" && service !== "github") return undefined;
  const seconds = Number(record.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return {
    jobId,
    service,
    stage: String(record.stage ?? ""),
    reason: String(record.reason ?? ""),
    seconds,
    at: line.at,
  };
}

export function recordRateLimitWait(input: RateLimitWaitInput): void {
  const jobId = input.jobId ?? currentRateLimitJobId();
  if (!jobId || !isAppDbOpen()) return;
  if (!Number.isFinite(input.seconds) || input.seconds <= 0) return;
  appendLog(
    jobId,
    "warn",
    JSON.stringify({
      type: RATE_LIMIT_WAIT_LOG_TYPE,
      service: input.service,
      stage: input.stage,
      reason: input.reason,
      seconds: input.seconds,
    }),
  );
}

export function listRateLimitWaits(jobId: string): RateLimitWait[] {
  if (!isAppDbOpen()) return [];
  return listLogs(jobId).flatMap((line) => {
    const wait = parseWait(jobId, line);
    return wait ? [wait] : [];
  });
}

export function summarizeRateLimitWaits(
  waits: RateLimitWait[],
): RateLimitWaitSummary {
  return {
    count: waits.length,
    totalSeconds: waits.reduce((sum, wait) => sum + wait.seconds, 0),
  };
}

export function latestSyncJob(repo: string): JobRow | undefined {
  if (!isAppDbOpen()) return undefined;
  return listJobs({ repo }).find(
    (job) => job.type === "init" || job.type === "remake",
  );
}

export function latestSyncRateLimitWaits(repo: string): {
  job: JobRow | undefined;
  waits: RateLimitWait[];
  summary: RateLimitWaitSummary;
} {
  const job = latestSyncJob(repo);
  const waits = job ? listRateLimitWaits(job.id) : [];
  return { job, waits, summary: summarizeRateLimitWaits(waits) };
}
