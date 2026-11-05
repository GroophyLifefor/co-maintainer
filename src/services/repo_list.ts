/** One status rule for the repository list, shared by the home page and
 * `GET /api/repos`, so a filter tab and the API never disagree on which
 * repositories are "Reviewing". */
import type { RepoListItem } from "./dashboard.ts";
import { readConfig, resolveAppPrivateKey } from "../config.ts";

/** Whether a GitHub App is configured to post reviews with. */
export function appReady(): boolean {
  const config = readConfig();
  return Boolean(config.githubAppId && resolveAppPrivateKey(config));
}

export type RepoState = "reviewing" | "paused" | "setting-up" | "setup-failed";

/** "Reviewing" only when a pull request would really be reviewed: auto review
 * on, a GitHub App to post with, knowledge built and no setup job running. A
 * repository still being set up or without an App is never labelled
 * Reviewing. */
export function repoState(item: RepoListItem, appReady: boolean): RepoState {
  const job = item.latestJob;
  if (job && (job.status === "running" || job.status === "queued")) {
    return "setting-up";
  }
  if (job?.status === "failed" && !item.repo.knowledge_built_at) {
    return "setup-failed";
  }
  return item.repo.auto_review === 1 && appReady && item.repo.knowledge_built_at
    ? "reviewing"
    : "paused";
}

/** `status` is "reviewing", "paused" or anything else for all. "paused"
 * lists every repository that is not Reviewing. `q` matches the full name,
 * ignoring case. */
export function filterRepoList<T extends RepoListItem>(
  items: T[],
  opts: { q?: string; status?: string },
  appReady: boolean,
): T[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  return items.filter((item) => {
    if (q && !item.repo.full_name.toLowerCase().includes(q)) return false;
    const reviewing = repoState(item, appReady) === "reviewing";
    if (opts.status === "reviewing") return reviewing;
    if (opts.status === "paused") return !reviewing;
    return true;
  });
}
