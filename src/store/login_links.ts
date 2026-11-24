/** The one-time sign-in link's row. Only the token's hash is stored, the
 * hashing is `server/auth.ts`'s concern. */
import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";

/** A new link replaces every older one, in one transaction. */
export function replaceLoginLink(
  tokenHash: string,
  host: string,
  expiresAt: string,
): void {
  const db = getAppDb();
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM login_links`).run();
    db.prepare(
      `INSERT INTO login_links (token_hash, host, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    ).run(tokenHash, host, nowIso(), expiresAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Spends the link in one statement, so two requests with the same link
 * cannot both win. False when it is unknown, spent, expired, made for
 * another host, or older than the last credential change. */
export function spendLoginLink(
  tokenHash: string,
  host: string,
  credentialsChangedAt?: string,
): boolean {
  const now = nowIso();
  const result = getAppDb()
    .prepare(
      `UPDATE login_links SET used_at = ?
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND host = ? AND created_at >= ?`,
    )
    .run(now, tokenHash, now, host, credentialsChangedAt ?? "");
  return Number(result.changes) === 1;
}
