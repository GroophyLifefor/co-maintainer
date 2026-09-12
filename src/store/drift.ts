import { getAppDb } from "./app_db.ts";
import type { DriftRow } from "./rows.ts";

export function upsertDrift(row: DriftRow): void {
  getAppDb().prepare(
    `INSERT INTO drift
       (repo, as_of, prs_since, prs_updated, commits_since, files_changed)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo) DO UPDATE SET
       as_of = excluded.as_of,
       prs_since = excluded.prs_since,
       prs_updated = excluded.prs_updated,
       commits_since = excluded.commits_since,
       files_changed = excluded.files_changed`,
  ).run(
    row.repo,
    row.as_of,
    row.prs_since,
    row.prs_updated,
    row.commits_since,
    row.files_changed,
  );
}

export function deleteDrift(repo: string): void {
  getAppDb().prepare(`DELETE FROM drift WHERE repo = ?`).run(repo);
}

export function getDrift(repo: string): DriftRow | undefined {
  return getAppDb().prepare<DriftRow>(`SELECT * FROM drift WHERE repo = ?`)
    .get(repo);
}
