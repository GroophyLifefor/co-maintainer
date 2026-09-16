import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import type { RevisionFile } from "../review/revision.ts";
import type { SubjectRevisionRow, SubjectRow } from "./rows.ts";

export function getOrCreatePrSubject(
  repo: string,
  prNumber: number,
): SubjectRow {
  const db = getAppDb();
  const existing = db.prepare<SubjectRow>(
    `SELECT * FROM subjects WHERE kind = 'pr' AND repo = ? AND pr_number = ?`,
  ).get(repo, prNumber);
  if (existing) return existing;
  const row: SubjectRow = {
    id: crypto.randomUUID(),
    kind: "pr",
    repo,
    pr_number: prNumber,
    branch: null,
    token_id: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO subjects (id, kind, repo, pr_number, branch, token_id, created_at, updated_at)
     VALUES (?, 'pr', ?, ?, NULL, NULL, ?, ?)`,
  ).run(row.id, repo, prNumber, row.created_at, row.updated_at);
  return row;
}

export function getSubjectRevision(
  subjectId: string,
): SubjectRevisionRow | undefined {
  return getAppDb().prepare<SubjectRevisionRow>(
    `SELECT * FROM subject_revisions WHERE subject_id = ?`,
  ).get(subjectId);
}

export function saveSubjectRevision(input: {
  subjectId: string;
  reviewId: string;
  files: RevisionFile[];
  visiblePaths: string[];
  guideBuiltAt: string | null;
}): void {
  const createdAt = nowIso();
  getAppDb().prepare(
    `INSERT INTO subject_revisions
       (subject_id, review_id, files_json, visible_paths_json, guide_built_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject_id) DO UPDATE SET
       review_id = excluded.review_id,
       files_json = excluded.files_json,
       visible_paths_json = excluded.visible_paths_json,
       guide_built_at = excluded.guide_built_at,
       created_at = excluded.created_at`,
  ).run(
    input.subjectId,
    input.reviewId,
    JSON.stringify(input.files),
    JSON.stringify(input.visiblePaths),
    input.guideBuiltAt,
    createdAt,
  );
  getAppDb().prepare(`UPDATE subjects SET updated_at = ? WHERE id = ?`).run(
    createdAt,
    input.subjectId,
  );
}

export function parseRevisionFiles(row: SubjectRevisionRow): RevisionFile[] {
  return JSON.parse(row.files_json) as RevisionFile[];
}

export function parseVisiblePaths(row: SubjectRevisionRow): Set<string> {
  return new Set(JSON.parse(row.visible_paths_json) as string[]);
}
