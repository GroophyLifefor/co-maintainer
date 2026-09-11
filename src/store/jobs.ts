/** Row storage only; queue behaviour (claim, supersede, debounce) lives in
 * `services/jobs.ts`, built on top of these primitives. */
import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import type { JobRow } from "./rows.ts";

export function insertJob(row: {
  id: string;
  type: string;
  repo: string;
  prNumber?: number;
  args?: unknown;
  deliveryId?: string;
}): void {
  getAppDb().prepare(
    `INSERT INTO jobs (id, type, repo, pr_number, status, args, delivery_id, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
  ).run(
    row.id,
    row.type,
    row.repo,
    row.prNumber ?? null,
    JSON.stringify(row.args ?? {}),
    row.deliveryId ?? null,
    nowIso(),
  );
}

export function setJobStatus(
  id: string,
  status: JobRow["status"],
  patch: Partial<Pick<JobRow, "error" | "superseded_by">> = {},
): void {
  const startedAt = status === "running" ? nowIso() : undefined;
  const finishedAt = ["done", "failed", "canceled"].includes(status)
    ? nowIso()
    : undefined;
  getAppDb().prepare(
    `UPDATE jobs SET status = ?,
       started_at = COALESCE(?, started_at),
       finished_at = COALESCE(?, finished_at),
       error = COALESCE(?, error),
       superseded_by = COALESCE(?, superseded_by)
     WHERE id = ?`,
  ).run(
    status,
    startedAt ?? null,
    finishedAt ?? null,
    patch.error ?? null,
    patch.superseded_by ?? null,
    id,
  );
}

export function getJob(id: string): JobRow | undefined {
  return getAppDb().prepare<JobRow>(`SELECT * FROM jobs WHERE id = ?`).get(id);
}

export function listJobs(
  filter: { status?: string; repo?: string } = {},
): JobRow[] {
  const clauses: string[] = [];
  const params: (string)[] = [];
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.repo) {
    clauses.push("repo = ?");
    params.push(filter.repo);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return getAppDb().prepare<JobRow>(
    `SELECT * FROM jobs ${where} ORDER BY created_at DESC`,
  ).all(...params);
}

/** The queued job for this (repo, PR), if any — the unique partial index
 * guarantees there is at most one. */
export function getQueuedJob(
  repo: string,
  prNumber: number,
): JobRow | undefined {
  return getAppDb().prepare<JobRow>(
    `SELECT * FROM jobs WHERE repo = ? AND pr_number = ? AND status = 'queued'`,
  ).get(repo, prNumber);
}

export function getOldestQueuedJob(): JobRow | undefined {
  return getAppDb().prepare<JobRow>(
    `SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
  ).get();
}

/** Atomically queued -> running. Returns false if someone else claimed it
 * first (or it was superseded/canceled in the meantime) — the caller must
 * not assume a claim it did not win. */
export function claimJob(id: string): boolean {
  const db = getAppDb();
  db.prepare(
    `UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`,
  ).run(nowIso(), id);
  return db.changes > 0;
}
