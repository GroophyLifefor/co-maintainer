/** Failures someone has seen, and failures a later review resolved.
 *
 * A failure is a failed job and the review row it wrote, if it wrote one. A
 * dismissed failure keeps its rows and gets a seen time, so it stays in the
 * history. A successful review of a pull request resolves every earlier
 * failure of that pull request by itself. The menu badge counts what is
 * neither seen nor resolved. */
import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import { countActivity, countActivityByRepo } from "./activity.ts";

/** Marks failures as seen. Job ids also mark the review rows those jobs
 * wrote. Review ids are for a review row with no job row left. Returns how
 * many rows changed. Only failed rows are touched. */
export function dismissFailures(
  ids: { jobs?: string[]; reviews?: string[] },
  at = nowIso(),
): number {
  const db = getAppDb();
  let changed = 0;
  for (const id of ids.jobs ?? []) {
    db.prepare(
      `UPDATE jobs SET seen_at = ? WHERE id = ? AND status = 'failed' AND seen_at IS NULL`,
    ).run(at, id);
    changed += db.changes;
    db.prepare(
      `UPDATE reviews SET seen_at = ? WHERE job_id = ? AND status = 'failed' AND seen_at IS NULL`,
    ).run(at, id);
    changed += db.changes;
  }
  for (const id of ids.reviews ?? []) {
    db.prepare(
      `UPDATE reviews SET seen_at = ? WHERE id = ? AND status = 'failed' AND seen_at IS NULL`,
    ).run(at, id);
    changed += db.changes;
  }
  return changed;
}

/** Marks every failure not seen yet as seen, of one repository or of all. */
export function dismissAllFailures(repo?: string, at = nowIso()): number {
  const db = getAppDb();
  const where = repo ? ` AND repo = ?` : "";
  const params = repo ? [at, repo] : [at];
  db.prepare(
    `UPDATE jobs SET seen_at = ? WHERE status = 'failed' AND seen_at IS NULL${where}`,
  ).run(...params);
  let changed = db.changes;
  db.prepare(
    `UPDATE reviews SET seen_at = ? WHERE status = 'failed' AND seen_at IS NULL${where}`,
  ).run(...params);
  changed += db.changes;
  return changed;
}

/** Called when a pull request review is posted: every earlier failed review
 * and failed review job of the same pull request is resolved by it. */
export function resolveEarlierFailures(reviewId: string): void {
  const db = getAppDb();
  const review = db
    .prepare<{
      repo: string;
      pr_number: number | null;
      created_at: string;
      kind: string;
    }>(`SELECT repo, pr_number, created_at, kind FROM reviews WHERE id = ?`)
    .get(reviewId);
  if (!review || review.kind !== "pr" || review.pr_number === null) return;
  db.prepare(
    `UPDATE reviews SET resolved_by = ?
     WHERE kind = 'pr' AND status = 'failed' AND resolved_by IS NULL
       AND repo = ? AND pr_number = ? AND created_at <= ? AND id != ?`,
  ).run(reviewId, review.repo, review.pr_number, review.created_at, reviewId);
  db.prepare(
    `UPDATE jobs SET resolved_by = ?
     WHERE type = 'review' AND status = 'failed' AND resolved_by IS NULL
       AND repo = ? AND pr_number = ? AND created_at <= ?`,
  ).run(reviewId, review.repo, review.pr_number, review.created_at);
}

/** Failures since `sinceIso` that nobody dismissed and no later review
 * resolved: the rows the failed Activity list shows for the same window, so
 * every count of open failures matches the list it opens. */
export function openFailureCount(sinceIso: string, repo?: string): number {
  return countActivity({ state: "failed", sinceIso, repo });
}

/** The same count for every repository at once. */
export function openFailureCountsByRepo(sinceIso: string): Map<string, number> {
  return countActivityByRepo({ state: "failed", sinceIso });
}
