/** Stores only the token's hash, never the raw token — hashing itself is
 * `server/auth.ts`'s concern, not this module's. */
import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import type { SessionRow } from "./rows.ts";

export function insertSession(
  tokenHash: string,
  username: string,
  expiresAt: string,
): void {
  const now = nowIso();
  getAppDb().prepare(
    `INSERT INTO sessions (token_hash, username, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tokenHash, username, now, expiresAt, now);
}

/** Returns the session only if it exists and has not expired, touching
 * `last_seen_at` on the way — an expired row is left for
 * `deleteExpiredSessions` to reap rather than deleted here. */
export function getSession(tokenHash: string): SessionRow | undefined {
  const db = getAppDb();
  const row = db.prepare<SessionRow>(
    `SELECT * FROM sessions WHERE token_hash = ?`,
  ).get(tokenHash);
  if (!row || row.expires_at <= nowIso()) return undefined;
  db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`)
    .run(nowIso(), tokenHash);
  return row;
}

export function deleteSession(tokenHash: string): void {
  getAppDb().prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(
    tokenHash,
  );
}

export function deleteExpiredSessions(): void {
  getAppDb().prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(
    nowIso(),
  );
}
