/** Commit watch tables: the pushes to a default branch, the issues opened
 * for their P0/P1 findings, and the notes maintainers left on those issues. */
import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import type { ReviewRow, SubjectRow } from "./rows.ts";

export type PushSource = "app" | "ci";

export type PushEventRow = {
  repo: string;
  after_sha: string;
  before_sha: string;
  ref: string;
  /** JSON array of `PushSource`. */
  sources: string;
  review_id: string | null;
  job_id: string | null;
  created_at: string;
};

export type WatchIssueState =
  | "open"
  | "closed_by_us"
  | "closed_by_user"
  | "ignored";

/** For an issue a maintainer closed: `pending` until the first push review
 * after the closing checks it, then `still_found` or `fixed`. */
export type ClosedCheck = "pending" | "still_found" | "fixed";

export type WatchIssueRow = {
  id: string;
  repo: string;
  issue_number: number;
  severity: string;
  title: string;
  body_md: string;
  path: string | null;
  line_from: number | null;
  line_to: number | null;
  anchor_text: string | null;
  state: WatchIssueState;
  closed_check: ClosedCheck | null;
  opened_review_id: string;
  last_review_id: string | null;
  last_check: string | null;
  last_check_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WatchNoteRow = {
  id: string;
  repo: string;
  issue_number: number;
  comment_id: string;
  author: string | null;
  kind: "ignore" | "info";
  body: string;
  note: string | null;
  created_at: string;
  applied_at: string | null;
};

export function pushSources(row: PushEventRow): PushSource[] {
  try {
    const parsed = JSON.parse(row.sources) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((s): s is PushSource => s === "app" || s === "ci")
      : [];
  } catch {
    return [];
  }
}

export function getPushEvent(
  repo: string,
  afterSha: string,
): PushEventRow | undefined {
  return getAppDb()
    .prepare<PushEventRow>(
      `SELECT * FROM push_events WHERE repo = ? AND after_sha = ?`,
    )
    .get(repo, afterSha);
}

export function insertPushEvent(row: {
  repo: string;
  afterSha: string;
  beforeSha: string;
  ref: string;
  source: PushSource;
}): void {
  getAppDb()
    .prepare(
      `INSERT INTO push_events
       (repo, after_sha, before_sha, ref, sources, review_id, job_id, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(
      row.repo,
      row.afterSha,
      row.beforeSha,
      row.ref,
      JSON.stringify([row.source]),
      nowIso(),
    );
}

export function addPushSource(
  repo: string,
  afterSha: string,
  source: PushSource,
): void {
  const row = getPushEvent(repo, afterSha);
  if (!row) return;
  const sources = new Set(pushSources(row));
  sources.add(source);
  getAppDb()
    .prepare(
      `UPDATE push_events SET sources = ? WHERE repo = ? AND after_sha = ?`,
    )
    .run(JSON.stringify([...sources]), repo, afterSha);
}

export function setPushEventReview(
  repo: string,
  afterSha: string,
  reviewId: string,
  jobId: string,
): void {
  getAppDb()
    .prepare(
      `UPDATE push_events SET review_id = ?, job_id = ?
     WHERE repo = ? AND after_sha = ?`,
    )
    .run(reviewId, jobId, repo, afterSha);
}

/** Every push whose review moves to a merged one, so a CI step still waiting
 * on an older push finds the review that now covers it. */
export function movePushEvents(
  fromReviewId: string,
  toReviewId: string,
  toJobId: string,
): void {
  getAppDb()
    .prepare(
      `UPDATE push_events SET review_id = ?, job_id = ? WHERE review_id = ?`,
    )
    .run(toReviewId, toJobId, fromReviewId);
}

export function listPushEventsForReview(reviewId: string): PushEventRow[] {
  return getAppDb()
    .prepare<PushEventRow>(
      `SELECT * FROM push_events WHERE review_id = ? ORDER BY created_at`,
    )
    .all(reviewId);
}

export function getOrCreatePushSubject(
  repo: string,
  branch: string,
): SubjectRow {
  const db = getAppDb();
  const existing = db
    .prepare<SubjectRow>(
      `SELECT * FROM subjects WHERE kind = 'push' AND repo = ? AND branch = ?`,
    )
    .get(repo, branch);
  if (existing) return existing;
  const row: SubjectRow = {
    id: crypto.randomUUID(),
    kind: "push",
    repo,
    pr_number: null,
    branch,
    token_id: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO subjects (id, kind, repo, pr_number, branch, token_id, created_at, updated_at)
     VALUES (?, 'push', ?, NULL, ?, NULL, ?, ?)`,
  ).run(row.id, repo, branch, row.created_at, row.updated_at);
  return row;
}

export function insertPushReview(row: {
  id: string;
  subjectId: string;
  repo: string;
  branch: string;
  jobId: string;
  beforeSha: string;
  afterSha: string;
  model: string;
}): void {
  getAppDb()
    .prepare(
      `INSERT INTO reviews
       (id, kind, subject_id, repo, pr_number, branch, token_id, token_name,
        job_id, head_sha, base_sha, scope, model, status, created_at, round,
        "trigger", cost_status, cost_note, billed_to)
     VALUES (?, 'push', ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, 'push', ?, 'queued', ?, 1,
        'push', 'unknown', 'not_recorded', 'server')`,
    )
    .run(
      row.id,
      row.subjectId,
      row.repo,
      row.branch,
      row.jobId,
      row.afterSha,
      row.beforeSha,
      row.model,
      nowIso(),
    );
}

export function setPushReviewRange(reviewId: string, beforeSha: string): void {
  getAppDb()
    .prepare(`UPDATE reviews SET base_sha = ? WHERE id = ?`)
    .run(beforeSha, reviewId);
}

export function listPushReviewsForRepo(repo: string, limit = 50): ReviewRow[] {
  return getAppDb()
    .prepare<ReviewRow>(
      `SELECT * FROM reviews WHERE repo = ? AND kind = 'push'
     ORDER BY created_at DESC LIMIT ?`,
    )
    .all(repo, limit);
}

export function latestPushReview(repo: string): ReviewRow | undefined {
  return getAppDb()
    .prepare<ReviewRow>(
      `SELECT * FROM reviews WHERE repo = ? AND kind = 'push'
     ORDER BY created_at DESC LIMIT 1`,
    )
    .get(repo);
}

export function savePushInput(jobId: string, revisionJson: string): void {
  getAppDb()
    .prepare(
      `INSERT OR REPLACE INTO push_inputs (job_id, revision_json, created_at)
     VALUES (?, ?, ?)`,
    )
    .run(jobId, revisionJson, nowIso());
}

export function getPushInput(jobId: string): string | undefined {
  return getAppDb()
    .prepare<{ revision_json: string }>(
      `SELECT revision_json FROM push_inputs WHERE job_id = ?`,
    )
    .get(jobId)?.revision_json;
}

export function deletePushInput(jobId: string): void {
  getAppDb().prepare(`DELETE FROM push_inputs WHERE job_id = ?`).run(jobId);
}

export function savePushResult(reviewId: string, result: unknown): void {
  getAppDb()
    .prepare(
      `INSERT OR REPLACE INTO push_results (review_id, result_json, created_at)
     VALUES (?, ?, ?)`,
    )
    .run(reviewId, JSON.stringify(result), nowIso());
}

export function getPushResult(
  reviewId: string,
): Record<string, unknown> | undefined {
  const raw = getAppDb()
    .prepare<{ result_json: string }>(
      `SELECT result_json FROM push_results WHERE review_id = ?`,
    )
    .get(reviewId)?.result_json;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function insertWatchIssue(row: {
  repo: string;
  issueNumber: number;
  severity: string;
  title: string;
  bodyMd: string;
  path: string | null;
  lineFrom: number | null;
  lineTo: number | null;
  anchorText: string | null;
  reviewId: string;
}): WatchIssueRow {
  const id = crypto.randomUUID();
  const now = nowIso();
  getAppDb()
    .prepare(
      `INSERT INTO watch_issues
       (id, repo, issue_number, severity, title, body_md, path, line_from,
        line_to, anchor_text, state, closed_check, opened_review_id,
        last_review_id, last_check, last_check_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      id,
      row.repo,
      row.issueNumber,
      row.severity,
      row.title,
      row.bodyMd,
      row.path,
      row.lineFrom,
      row.lineTo,
      row.anchorText,
      row.reviewId,
      row.reviewId,
      now,
      now,
    );
  return getWatchIssue(row.repo, row.issueNumber)!;
}

export function getWatchIssue(
  repo: string,
  issueNumber: number,
): WatchIssueRow | undefined {
  return getAppDb()
    .prepare<WatchIssueRow>(
      `SELECT * FROM watch_issues WHERE repo = ? AND issue_number = ?`,
    )
    .get(repo, issueNumber);
}

export function listWatchIssues(repo: string): WatchIssueRow[] {
  return getAppDb()
    .prepare<WatchIssueRow>(
      `SELECT * FROM watch_issues WHERE repo = ? ORDER BY issue_number`,
    )
    .all(repo);
}

export function updateWatchIssue(
  id: string,
  patch: Partial<
    Pick<
      WatchIssueRow,
      | "state"
      | "closed_check"
      | "path"
      | "line_from"
      | "line_to"
      | "anchor_text"
      | "last_review_id"
      | "last_check"
      | "last_check_at"
    >
  >,
): void {
  const fields = Object.keys(patch) as (keyof typeof patch)[];
  if (fields.length === 0) return;
  const set = [...fields.map((field) => `${field} = ?`), "updated_at = ?"].join(
    ", ",
  );
  getAppDb()
    .prepare(`UPDATE watch_issues SET ${set} WHERE id = ?`)
    .run(
      ...fields.map(
        (field) => (patch[field] ?? null) as string | number | null,
      ),
      nowIso(),
      id,
    );
}

export function insertWatchNote(row: {
  repo: string;
  issueNumber: number;
  commentId: string;
  author: string | null;
  kind: "ignore" | "info";
  body: string;
}): boolean {
  const result = getAppDb()
    .prepare(
      `INSERT OR IGNORE INTO watch_notes
       (id, repo, issue_number, comment_id, author, kind, body, note,
        created_at, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
    )
    .run(
      crypto.randomUUID(),
      row.repo,
      row.issueNumber,
      row.commentId,
      row.author,
      row.kind,
      row.body,
      nowIso(),
    );
  return Number(result.changes ?? 0) > 0;
}

export function listWatchNotes(repo: string): WatchNoteRow[] {
  return getAppDb()
    .prepare<WatchNoteRow>(
      `SELECT * FROM watch_notes WHERE repo = ? ORDER BY created_at`,
    )
    .all(repo);
}

export function markWatchNoteApplied(id: string, note: string): void {
  getAppDb()
    .prepare(`UPDATE watch_notes SET note = ?, applied_at = ? WHERE id = ?`)
    .run(note, nowIso(), id);
}
