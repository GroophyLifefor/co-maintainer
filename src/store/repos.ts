import { getAppDb } from "./app_db.ts";
import { deleteDrift } from "./drift.ts";
import { nowIso } from "../util/time.ts";
import type { RepoRow } from "./rows.ts";

export function activateRepo(
  fullName: string,
  installationId: number | undefined,
): void {
  getAppDb()
    .prepare(
      `INSERT INTO repos (full_name, installation_id, active, auto_review, created_at)
     VALUES (?, ?, 1, 1, ?)
     ON CONFLICT(full_name) DO UPDATE SET
       installation_id = excluded.installation_id, active = 1`,
    )
    .run(fullName, installationId ?? null, nowIso());
}

/** Adds a repository a CLI init built, unless it is already known (active,
 * or removed from the dashboard on purpose). It starts with automatic review
 * off: building knowledge from the CLI never opts a repository into posting
 * reviews. */
export function registerCliRepo(fullName: string, knowledgeBuiltAt?: string): boolean {
  const result = getAppDb()
    .prepare(
      `INSERT INTO repos (full_name, installation_id, active, auto_review, created_at, added_from, knowledge_built_at)
     VALUES (?, NULL, 1, 0, ?, 'cli', ?)
     ON CONFLICT(full_name) DO NOTHING`,
    )
    .run(fullName, nowIso(), knowledgeBuiltAt ?? null);
  return Number(result.changes) > 0;
}

export function deactivateRepo(fullName: string): void {
  getAppDb()
    .prepare(`UPDATE repos SET active = 0 WHERE full_name = ?`)
    .run(fullName);
}

export function deactivateReposForInstallation(installationId: number): void {
  getAppDb()
    .prepare(`UPDATE repos SET active = 0 WHERE installation_id = ?`)
    .run(installationId);
}

export function updateRepoSettings(
  fullName: string,
  patch: Partial<
    Pick<
      RepoRow,
      | "auto_review"
      | "review_scope"
      | "skip_drafts"
      | "skip_bots"
      | "use_codegraph"
      | "review_policy_json"
    >
  >,
): void {
  const fields = Object.keys(patch) as (keyof typeof patch)[];
  if (fields.length === 0) return;
  const set = fields.map((field) => `${field} = ?`).join(", ");
  getAppDb()
    .prepare(`UPDATE repos SET ${set} WHERE full_name = ?`)
    .run(
      ...fields.map((field) => patch[field] as unknown as string | number),
      fullName,
    );
}

export function markKnowledgeBuilt(fullName: string, baseSha: string): void {
  getAppDb()
    .prepare(
      `UPDATE repos SET knowledge_built_at = ?, knowledge_base_sha = ? WHERE full_name = ?`,
    )
    .run(nowIso(), baseSha, fullName);
  // The stored drift counts how far the repository moved past the previous
  // baseline, so a rebuild makes them meaningless rather than merely stale.
  deleteDrift(fullName);
}

/** Forgets the built knowledge: the stamp every review and the dashboard read
 * as "built", and the drift baseline that only meant anything against it. */
export function clearRepoKnowledge(fullName: string): void {
  getAppDb()
    .prepare(
      `UPDATE repos SET knowledge_built_at = NULL, knowledge_base_sha = NULL WHERE full_name = ?`,
    )
    .run(fullName);
  deleteDrift(fullName);
}

export function setInstallationId(
  fullName: string,
  installationId: number,
): void {
  getAppDb()
    .prepare(`UPDATE repos SET installation_id = ? WHERE full_name = ?`)
    .run(installationId, fullName);
}

export function getRepo(fullName: string): RepoRow | undefined {
  return getAppDb()
    .prepare<RepoRow>(`SELECT * FROM repos WHERE full_name = ?`)
    .get(fullName);
}

/** Case-insensitive match on `repos.full_name`. */
export function findRepoByFullName(fullName: string): RepoRow | undefined {
  return getAppDb()
    .prepare<RepoRow>(`SELECT * FROM repos WHERE lower(full_name) = lower(?)`)
    .get(fullName);
}

export function listActiveRepos(): RepoRow[] {
  return getAppDb()
    .prepare<RepoRow>(`SELECT * FROM repos WHERE active = 1 ORDER BY full_name`)
    .all();
}
