/** Is commit watch on for a repository, and through what.
 *
 * The App watches when its installation for the repository receives the
 * `push` event. That is a setting on GitHub, so it is read from
 * `GET /app/installations`, and cached for a minute so a page view does not
 * call GitHub every time. CI watches when a CI step has sent a push. */
import { AppJwtClient, findInstallationForRepo } from "../github/app.ts";
import { readConfig, resolveAppPrivateKey } from "../config.ts";
import { getRepo } from "../store/repos.ts";
import { getAppDb } from "../store/app_db.ts";
import { latestPushReview, type PushSource } from "../store/watch.ts";
import type { ReviewRow } from "../store/rows.ts";

export type AppPushState =
  /** No App is configured, or GitHub could not be asked. */
  | "unknown"
  /** No installation of the App covers the repository. */
  | "not-installed"
  | "off"
  | "on";

export type WatchStatus = {
  app: AppPushState;
  /** A CI step has sent at least one push. */
  ci: boolean;
  lastPush: (ReviewRow & { via: PushSource[] }) | undefined;
};

const CACHE_MS = 60_000;
let cache: { at: number; events: Map<number, string[]> } | undefined;

/** The events each installation receives, by installation id. */
async function installationEvents(): Promise<
  Map<number, string[]> | undefined
> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.events;
  const config = readConfig();
  const pem = resolveAppPrivateKey(config);
  if (!config.githubAppId || !pem) return undefined;
  try {
    const installations = await new AppJwtClient(
      config.githubAppId,
      pem,
    ).listInstallations();
    const events = new Map(
      installations.map((installation) => [
        installation.id,
        installation.events ?? [],
      ]),
    );
    cache = { at: Date.now(), events };
    return events;
  } catch {
    return undefined;
  }
}

/** For tests: forget what GitHub said. */
export function clearWatchStatusCache(): void {
  cache = undefined;
}

export async function appPushState(repo: string): Promise<AppPushState> {
  const events = await installationEvents();
  if (!events) return "unknown";
  const id = getRepo(repo)?.installation_id;
  if (!id || !events.has(id)) return "not-installed";
  return events.get(id)!.includes("push") ? "on" : "off";
}

/** For `probe`, which runs without app.db: whether the App's installation on
 * the repository receives `push`. Undefined when this machine has no App
 * configured, the App is not installed there, or GitHub could not be asked:
 * then `probe` says nothing about commit watch. */
export async function appPushStateWithoutDb(
  repo: string,
): Promise<"on" | "off" | undefined> {
  const config = readConfig();
  const pem = resolveAppPrivateKey(config);
  if (!config.githubAppId || !pem) return undefined;
  try {
    const id = await findInstallationForRepo(config.githubAppId, pem, repo);
    if (id === undefined) return undefined;
    const events = await installationEvents();
    const list = events?.get(id);
    if (!list) return undefined;
    return list.includes("push") ? "on" : "off";
  } catch {
    return undefined;
  }
}

function ciHasPushed(repo: string): boolean {
  const row = getAppDb()
    .prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM push_events
     WHERE repo = ? AND sources LIKE '%"ci"%'`,
    )
    .get(repo);
  return Number(row?.n ?? 0) > 0;
}

function viaOf(repo: string, review: ReviewRow): PushSource[] {
  const row = getAppDb()
    .prepare<{ sources: string }>(
      `SELECT sources FROM push_events WHERE repo = ? AND review_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    )
    .get(repo, review.id);
  try {
    const parsed = JSON.parse(row?.sources ?? "[]") as PushSource[];
    return parsed.filter((s) => s === "app" || s === "ci");
  } catch {
    return [];
  }
}

export function pushVia(repo: string, review: ReviewRow): PushSource[] {
  return viaOf(repo, review);
}

export async function watchStatus(repo: string): Promise<WatchStatus> {
  const last = latestPushReview(repo);
  return {
    app: await appPushState(repo),
    ci: ciHasPushed(repo),
    lastPush: last ? { ...last, via: viaOf(repo, last) } : undefined,
  };
}
