import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import type { InstallationRow } from "./rows.ts";

export function upsertInstallation(
  row: Pick<InstallationRow, "id" | "account_login" | "account_type"> & {
    permissions: unknown;
    events: string[];
  },
): void {
  getAppDb().prepare(
    `INSERT INTO installations (id, account_login, account_type, permissions, events, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account_login = excluded.account_login,
       account_type = excluded.account_type,
       permissions = excluded.permissions,
       events = excluded.events,
       suspended_at = NULL,
       removed_at = NULL`,
  ).run(
    row.id,
    row.account_login,
    row.account_type,
    JSON.stringify(row.permissions),
    JSON.stringify(row.events),
    nowIso(),
  );
}

export function markInstallationSuspended(
  id: number,
  suspended: boolean,
): void {
  getAppDb().prepare(
    `UPDATE installations SET suspended_at = ? WHERE id = ?`,
  ).run(suspended ? nowIso() : null, id);
}

export function markInstallationRemoved(id: number): void {
  getAppDb().prepare(
    `UPDATE installations SET removed_at = ? WHERE id = ?`,
  ).run(nowIso(), id);
}

export function getInstallation(id: number): InstallationRow | undefined {
  return getAppDb().prepare<InstallationRow>(
    `SELECT * FROM installations WHERE id = ?`,
  ).get(id);
}

export function listInstallations(): InstallationRow[] {
  return getAppDb().prepare<InstallationRow>(
    `SELECT * FROM installations ORDER BY account_login`,
  ).all();
}
