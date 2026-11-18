/** Pull request titles for the dashboard, kept from the last time a review
 * read the pull request, so a page never asks GitHub for one per view. */
import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";

export function rememberPullTitle(
  repo: string,
  prNumber: number,
  title: unknown,
): void {
  if (typeof title !== "string" || !title.trim()) return;
  getAppDb()
    .prepare(
      `INSERT INTO pull_titles (repo, pr_number, title, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       title = excluded.title, updated_at = excluded.updated_at`,
    )
    .run(repo, prNumber, title.trim(), nowIso());
}

export function getPullTitle(
  repo: string,
  prNumber: number,
): string | undefined {
  return getAppDb()
    .prepare<{ title: string }>(
      `SELECT title FROM pull_titles WHERE repo = ? AND pr_number = ?`,
    )
    .get(repo, prNumber)?.title;
}
