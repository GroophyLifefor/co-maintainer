/** In-memory BYOK key store for remote reviews (CORE-110).
 *
 * A client's own AI key lives only here, keyed by job id, for the life of the
 * job. It is never written to a table, a log line, or an error message. The
 * key is gone the moment the job finishes, fails, is canceled, or is
 * superseded, and a server restart empties this map, which is exactly the
 * documented "your key was not kept across a restart" behavior.
 *
 * Why a module-level Map rather than the DB: a persisted key would survive a
 * restart and be readable by anything that reads the database file, which is
 * the leak the plan's byte-scan test exists to prevent. */
const keys = new Map<string, string>();

/** Remembers a key for one job. An empty key is not stored. */
export function registerByokKey(jobId: string, key: string): void {
  if (key) keys.set(jobId, key);
}

/** The key for a job, or undefined when none was submitted or it was already
 * dropped. Callers must treat undefined as "no key", never as "use the
 * server key" without checking the policy first. */
export function getByokKey(jobId: string): string | undefined {
  return keys.get(jobId);
}

export function hasByokKey(jobId: string): boolean {
  return keys.has(jobId);
}

/** Called on every terminal path: done, failed, canceled, superseded. */
export function dropByokKey(jobId: string): void {
  keys.delete(jobId);
}

/** Test-only hook so a scenario can simulate a server restart without a new
 * process. Not used in production code. */
export function clearByokKeysForTest(): void {
  keys.clear();
}
