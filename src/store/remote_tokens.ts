import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import type { RemoteTokenRow } from "./rows.ts";

export function insertRemoteToken(
  id: string,
  name: string,
  tokenHash: string,
): void {
  getAppDb().prepare(
    `INSERT INTO remote_tokens (id, name, token_hash, active, created_at)
     VALUES (?, ?, ?, 1, ?)`,
  ).run(id, name, tokenHash, nowIso());
}

export function findRemoteTokenByHash(
  tokenHash: string,
): RemoteTokenRow | undefined {
  return getAppDb().prepare<RemoteTokenRow>(
    `SELECT * FROM remote_tokens WHERE token_hash = ?`,
  ).get(tokenHash);
}

export function getRemoteToken(id: string): RemoteTokenRow | undefined {
  return getAppDb().prepare<RemoteTokenRow>(
    `SELECT * FROM remote_tokens WHERE id = ?`,
  ).get(id);
}

export function findRemoteTokenByName(name: string): RemoteTokenRow | undefined {
  return getAppDb().prepare<RemoteTokenRow>(
    `SELECT * FROM remote_tokens WHERE name = ?`,
  ).get(name);
}

export function listRemoteTokens(): RemoteTokenRow[] {
  return getAppDb().prepare<RemoteTokenRow>(
    `SELECT * FROM remote_tokens ORDER BY created_at DESC`,
  ).all();
}

export function setRemoteTokenActive(id: string, active: boolean): void {
  getAppDb().prepare(`UPDATE remote_tokens SET active = ? WHERE id = ?`).run(
    active ? 1 : 0,
    id,
  );
}

export function deleteRemoteToken(id: string): void {
  getAppDb().prepare(`DELETE FROM remote_tokens WHERE id = ?`).run(id);
}

/** At most one write per minute per token (plan §14.2). */
export function touchRemoteToken(id: string): void {
  const now = nowIso();
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  getAppDb().prepare(
    `UPDATE remote_tokens SET last_used_at = ?
     WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
  ).run(now, id, minuteAgo);
}
