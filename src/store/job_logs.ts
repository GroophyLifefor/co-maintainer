import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import type { JobLogRow } from "./rows.ts";

export function appendLog(
  jobId: string,
  level: string,
  message: string,
): number {
  const db = getAppDb();
  const nextSeq = (db.prepare<{ max_seq: number | null }>(
    `SELECT MAX(seq) AS max_seq FROM job_logs WHERE job_id = ?`,
  ).get(jobId)?.max_seq ?? 0) + 1;
  db.prepare(
    `INSERT INTO job_logs (job_id, seq, at, level, message) VALUES (?, ?, ?, ?, ?)`,
  ).run(jobId, nextSeq, nowIso(), level, message);
  return nextSeq;
}

/** `fromSeq` makes the SSE stream resumable: a client that reconnects asks
 * for everything after the last `seq` it saw. */
export function listLogs(jobId: string, fromSeq = 0): JobLogRow[] {
  return getAppDb().prepare<JobLogRow>(
    `SELECT * FROM job_logs WHERE job_id = ? AND seq > ? ORDER BY seq`,
  ).all(jobId, fromSeq);
}
