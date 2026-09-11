import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import type { RepoRow } from "./rows.ts";

export function activateRepo(
  fullName: string,
  installationId: number | undefined,
): void {
  getAppDb().prepare(
    `INSERT INTO repos (full_name, installation_id, active, auto_review, created_at)
     VALUES (?, ?, 1, 1, ?)
     ON CONFLICT(full_name) DO UPDATE SET
       installation_id = excluded.installation_id, active = 1`,
  ).run(fullName, installationId ?? null, nowIso());
}

export function deactivateRepo(fullName: string): void {
  getAppDb().prepare(`UPDATE repos SET active = 0 WHERE full_name = ?`)
    .run(fullName);
}

export function deactivateReposForInstallation(installationId: number): void {
  getAppDb().prepare(`UPDATE repos SET active = 0 WHERE installation_id = ?`)
    .run(installationId);
}

export function updateRepoSettings(
  fullName: string,
  patch: Partial<
    Pick<
      RepoRow,
      "auto_review" | "review_scope" | "skip_drafts" | "skip_bots"
    >
  >,
): void {
  const fields = Object.keys(patch) as (keyof typeof patch)[];
  if (fields.length === 0) return;
  const set = fields.map((field) => `${field} = ?`).join(", ");
  getAppDb().prepare(`UPDATE repos SET ${set} WHERE full_name = ?`).run(
    ...fields.map((field) => patch[field] as unknown as string | number),
    fullName,
  );
}

export function markKnowledgeBuilt(fullName: string, baseSha: string): void {
  getAppDb().prepare(
    `UPDATE repos SET knowledge_built_at = ?, knowledge_base_sha = ? WHERE full_name = ?`,
  ).run(nowIso(), baseSha, fullName);
}

export function setInstallationId(
  fullName: string,
  installationId: number,
): void {
  getAppDb().prepare(`UPDATE repos SET installation_id = ? WHERE full_name = ?`)
    .run(installationId, fullName);
}

export function getRepo(fullName: string): RepoRow | undefined {
  return getAppDb().prepare<RepoRow>(
    `SELECT * FROM repos WHERE full_name = ?`,
  ).get(fullName);
}

export function listActiveRepos(): RepoRow[] {
  return getAppDb().prepare<RepoRow>(
    `SELECT * FROM repos WHERE active = 1 ORDER BY full_name`,
  ).all();
}
