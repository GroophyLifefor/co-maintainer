/** Pull request titles and authors for the dashboard, kept from the last
 * time a review read the pull request, so a page never asks GitHub for one
 * per view. */
import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";

export function rememberPullTitle(
  repo: string,
  prNumber: number,
  title: unknown,
  /** The GitHub login that opened the pull request, when known. A call
   * without one keeps the author already stored. */
  author?: unknown,
): void {
  if (typeof title !== "string" || !title.trim()) return;
  const login =
    typeof author === "string" && author.trim() ? author.trim() : null;
  getAppDb()
    .prepare(
      `INSERT INTO pull_titles (repo, pr_number, title, updated_at, author)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       title = excluded.title, updated_at = excluded.updated_at,
       author = COALESCE(excluded.author, pull_titles.author)`,
    )
    .run(repo, prNumber, title.trim(), nowIso(), login);
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
