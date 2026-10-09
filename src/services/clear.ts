/** Deleting what `init` produced, for the CLI's `clear`/`uninstall` and the
 * dashboard's clear actions.
 *
 * The dashboard and the CLI share this module on purpose: the same data has to
 * disappear whether a command or a button asked for it. The callers keep what
 * differs instead: the CLI owns the `serve` lock guard, its prompts and its
 * output, the dashboard route owns job negotiation before calling in.
 *
 * Deleting is ordered so an interruption never leaves the friendlier state:
 * the app.db knowledge stamp goes first, then the guide files, then the
 * rebuildable cache. An error partway leaves a repository that reads as "not
 * built", which the next `init` fixes. */
import {
  cacheDbPath,
  cloneDir,
  clonesDir,
  configPath,
  getCacheDir,
  getConfigDir,
  locksDir,
  readConfig,
  removeAllRepoConfig,
  removeRepoConfig,
  repoWorktreesDir,
  reposDir,
  toolsDir,
  worktreesDir,
} from "../config.ts";
import { withKnowledgeLock } from "../review/guides.ts";
import {
  appDbLockPath,
  appDbPath,
  backupPaths,
  closeAppDb,
  isAppDbOpen,
  openAppDb,
} from "../store/app_db.ts";
import {
  cacheDbExists,
  cacheDeleteRepoEvidence,
  cacheDeleteRepoKnowledge,
} from "../store/cache_db.ts";
import { clearRepoKnowledge } from "../store/repos.ts";
import { listJobs, setJobStatus } from "../store/jobs.ts";
import { cancel } from "./jobs.ts";
import { isNotFound, readDir, remove, rmdir, stat } from "../util/runtime.ts";
import type { JobRow } from "../store/rows.ts";

/** Job cancel reasons, so the Activity page can say who asked. */
export const CLEARED_REASON = "knowledge_cleared";

export type ClearOptions = {
  /** Also drop the fetched evidence (pull request listings, AI job cache,
   * costs, local review carry-over, clones, worktrees). Without it the next
   * init still finds what it paid for and only the knowledge is gone. */
  includeCache?: boolean;
};

export type ClearRepoResult = {
  repo: string;
  guides: number;
  cacheRows: number;
  settings: boolean;
  clones: boolean;
  worktrees: boolean;
};

export type ClearAllResult = {
  repos: ClearRepoResult[];
  settings: boolean;
  cacheFile: boolean;
  clones: boolean;
  worktrees: boolean;
};

/** A repository name that is safe to join onto a directory. Rejects the `..`
 * segment the API's route pattern would otherwise accept. */
const REPO_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function isSafeRepoName(repo: string): boolean {
  if (!REPO_NAME.test(repo)) return false;
  return repo.split("/").every((part) => part !== "." && part !== "..");
}

function assertSafeRepoName(repo: string): void {
  if (!isSafeRepoName(repo)) {
    throw new Error(`Not a repository name: ${repo}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function removeIfExists(
  path: string,
  options?: { recursive?: boolean },
): Promise<boolean> {
  if (!(await pathExists(path))) return false;
  await remove(path, options);
  return true;
}

async function countEntries(dir: string): Promise<number> {
  let count = 0;
  try {
    for await (const _entry of readDir(dir)) count++;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return count;
}

/** Opens app.db for the work when it already exists, and never creates one:
 * a repository that was never inited has nothing to clear there. Reuses an
 * open connection (the dashboard) and closes one it opened itself. */
export async function withAppDbIfPresent<T>(
  fn: () => T | Promise<T>,
): Promise<T | undefined> {
  if (isAppDbOpen()) return await fn();
  if (!(await pathExists(appDbPath()))) return undefined;
  await openAppDb();
  try {
    return await fn();
  } finally {
    await closeAppDb();
  }
}

/** The repositories `clear all` should visit: the guide directories under
 * `reposDir()` plus everything `config.json` still remembers. Names that
 * cannot be joined onto a path are dropped: `config.json` is editable by
 * hand, and a key like `acme/..` would otherwise resolve to the repos root
 * and take every repository with it. */
export async function listStoredRepos(): Promise<string[]> {
  const repos = new Set<string>();
  try {
    for await (const owner of readDir(reposDir())) {
      if (!owner.isDirectory || owner.isSymlink) continue;
      try {
        for await (const child of readDir(`${reposDir()}/${owner.name}`)) {
          if (child.isDirectory && !child.isSymlink) {
            repos.add(`${owner.name}/${child.name}`);
          }
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  for (const repo of Object.keys(readConfig().repos ?? {})) repos.add(repo);
  return [...repos].filter(isSafeRepoName).sort();
}

/** Guide files live in one directory per repository. The count is taken
 * before the removal so the caller can report what went. An owner directory
 * left empty by its last repository is pruned: it is a leftover, not data. */
async function removeRepoGuides(repo: string): Promise<number> {
  let removed = 0;
  await withKnowledgeLock(repo, async () => {
    const dir = `${reposDir()}/${repo}`;
    removed = await countEntries(dir);
    if (removed > 0) await remove(dir, { recursive: true });
    else await removeIfExists(dir, { recursive: true });
    await rmdir(dir.slice(0, dir.lastIndexOf("/"))).catch(() => {});
  });
  return removed;
}

/** `sync` used to keep its state as `.cache/<repo>/state.json` beside the
 * working directory, and `readState` still falls back to it. Leaving it
 * behind would let a `sync` run after a clear, which clear promises cannot
 * happen. Best effort: it only exists on machines that ran the old layout. */
async function removeLegacyState(repo: string): Promise<void> {
  await removeIfExists(`${process.cwd()}/.cache/${repo}`, { recursive: true });
}

async function clearRepoCache(
  repo: string,
  includeCache: boolean,
): Promise<number> {
  if (!(await cacheDbExists())) return 0;
  let removed = await cacheDeleteRepoKnowledge(repo);
  if (includeCache) removed += await cacheDeleteRepoEvidence(repo);
  return removed;
}

/** What queued and running jobs exist for these repositories. Empty when
 * app.db is not open, which is the same as "no jobs to worry about". */
export function repoJobs(repos: string[]): {
  queued: JobRow[];
  running: JobRow[];
} {
  if (!isAppDbOpen()) return { queued: [], running: [] };
  const wanted = new Set(repos);
  const queued: JobRow[] = [];
  const running: JobRow[] = [];
  for (const job of listJobs({})) {
    if (!wanted.has(job.repo)) continue;
    if (job.status === "queued") queued.push(job);
    else if (job.status === "running") running.push(job);
  }
  return { queued, running };
}

/** Cancels queued jobs so a cleared repository does not rebuild itself from
 * the queue. Running jobs are the caller's problem: reviews can be aborted,
 * a running setup cannot (its fetch loops ignore the signal). */
export function cancelQueuedJobs(
  repos: string[],
  reason = CLEARED_REASON,
): number {
  if (!isAppDbOpen()) return 0;
  let canceled = 0;
  for (const job of repoJobs(repos).queued) {
    if (cancel(job.id, reason)) canceled++;
  }
  return canceled;
}

/** Aborts running reviews. They never write guides, so clearing while one
 * runs is safe either way; aborting stops the AI spend too. */
export function abortRunningReviews(
  repos: string[],
  reason = CLEARED_REASON,
): number {
  if (!isAppDbOpen()) return 0;
  let aborted = 0;
  for (const job of repoJobs(repos).running) {
    if (job.type !== "review" && job.type !== "remote_review") continue;
    if (cancel(job.id, reason)) aborted++;
  }
  return aborted;
}

/** Running rows left behind by a crashed `serve`. Only safe when the caller
 * holds the app.db lock, which the CLI guard guarantees. */
export function cancelOrphanedJobs(
  repos: string[],
  reason = CLEARED_REASON,
): number {
  if (!isAppDbOpen()) return 0;
  let canceled = 0;
  for (const job of repoJobs(repos).running) {
    setJobStatus(job.id, "canceled", { cancel_reason: reason });
    canceled++;
  }
  return canceled;
}

/** Forgets one repository: knowledge, guides, cache (when asked) and the
 * settings `init` remembered. */
export async function clearRepo(
  repo: string,
  options: ClearOptions = {},
): Promise<ClearRepoResult> {
  assertSafeRepoName(repo);
  await withAppDbIfPresent(() => clearRepoKnowledge(repo));
  const guides = await removeRepoGuides(repo);
  const cacheRows = await clearRepoCache(repo, Boolean(options.includeCache));
  await removeLegacyState(repo);
  const settings = await removeRepoConfig(repo);
  const clones = options.includeCache
    ? await removeIfExists(cloneDir(repo), { recursive: true })
    : false;
  const worktrees = options.includeCache
    ? await removeIfExists(repoWorktreesDir(repo), { recursive: true })
    : false;
  return { repo, guides, cacheRows, settings, clones, worktrees };
}

/** Forgets exactly the repositories it is given. The dashboard route and the
 * CLI pass the same snapshot they negotiated jobs against, so the list cannot
 * move between the check and the delete. The app.db file and its review
 * history stay: only the knowledge is gone. `--include-cache` takes the whole
 * cache database plus every clone and worktree, the same as deleting
 * `cache.db` by hand. */
export async function clearRepos(
  repos: string[],
  options: ClearOptions = {},
): Promise<ClearAllResult> {
  for (const repo of repos) assertSafeRepoName(repo);
  const results: ClearRepoResult[] = [];
  await withAppDbIfPresent(() => {
    for (const repo of repos) clearRepoKnowledge(repo);
  });
  for (const repo of repos) {
    const guides = await removeRepoGuides(repo);
    const cacheRows = options.includeCache
      ? 0
      : await clearRepoCache(repo, false);
    await removeLegacyState(repo);
    results.push({
      repo,
      guides,
      cacheRows,
      settings: false,
      clones: false,
      worktrees: false,
    });
  }
  const cacheFile = options.includeCache
    ? await removeIfExists(cacheDbPath())
    : false;
  const clones = options.includeCache
    ? await removeIfExists(clonesDir(), { recursive: true })
    : false;
  const worktrees = options.includeCache
    ? await removeIfExists(worktreesDir(), { recursive: true })
    : false;
  const settings = await removeAllRepoConfig();
  return { repos: results, settings, cacheFile, clones, worktrees };
}

/** Forgets every repository on this machine, from a fresh snapshot. */
export async function clearAllKnowledge(
  options: ClearOptions = {},
): Promise<ClearAllResult> {
  return await clearRepos(await listStoredRepos(), options);
}

export type UninstallResult = { paths: string[] };

/** Every file and directory co-maintainer keeps on this machine. The `tools`
 * directory (the codegraph install) goes too: uninstall means the disk is
 * back to what it was before the first `init`. */
function uninstallTargets(): string[] {
  const appDb = appDbPath();
  const cacheDb = cacheDbPath();
  return [
    configPath(),
    cacheDb,
    `${cacheDb}-journal`,
    appDb,
    `${appDb}-wal`,
    `${appDb}-shm`,
    appDbLockPath(),
    backupPaths().version,
    reposDir(),
    clonesDir(),
    worktreesDir(),
    locksDir(),
    toolsDir(),
    backupPaths().root,
  ];
}

/** Removes every co-maintainer data file. The npm package itself cannot be
 * removed from inside the running CLI, so the command prints how to do that
 * instead. Refuses nothing here; the caller checks for a running `serve`. */
export async function uninstallData(): Promise<UninstallResult> {
  // On Windows an open handle blocks the delete, and leaving wal/shm behind
  // would be worse than the file itself.
  if (isAppDbOpen()) await closeAppDb();
  const removed: string[] = [];
  for (const target of uninstallTargets()) {
    if (await removeIfExists(target, { recursive: true })) {
      removed.push(target);
    }
  }
  // The containing `co-maintainer` directories only survive if something
  // else put files there. `rmdir` refuses a non-empty directory, which is
  // what we want.
  for (const dir of [
    `${getConfigDir()}/co-maintainer`,
    `${getCacheDir()}/co-maintainer`,
  ]) {
    await rmdir(dir).catch(() => {});
  }
  return { paths: removed };
}
