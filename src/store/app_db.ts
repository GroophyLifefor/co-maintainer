import { dirname } from "node:path";
import { Database } from "./sqlite.ts";
import { cacheDbPath, configPath, getCacheDir } from "../config.ts";
import { VERSION } from "../version.ts";
import { log } from "../util/log.ts";
import { takeBackup, type BackupPaths } from "./backup.ts";
import { CliError, EXIT_RUNTIME, EXIT_USAGE } from "../cli/error.ts";
import { migrations } from "./migrations.ts";
import {
  getEnv,
  isNotFound,
  isProcessAlive,
  mkdir,
  readTextFile,
  remove,
  writeTextFile,
} from "../util/runtime.ts";

export function appDbDir(): string {
  return `${getCacheDir()}/co-maintainer`;
}

/** `CM_APP_DB` overrides the path — tests point it at a temp file. */
export function appDbPath(): string {
  return getEnv("CM_APP_DB") ?? `${appDbDir()}/app.db`;
}

function lockPath(): string {
  return `${appDbPath()}.lock`;
}

/** Where the backup taken before a migration lives, and what it covers. */
export function backupPaths(): BackupPaths {
  return {
    appDb: appDbPath(),
    cacheDb: cacheDbPath(),
    config: configPath(),
    version: versionPath(),
    root: `${dirname(appDbPath())}/backups`,
  };
}

/** The version that last opened this database, written after every open so
 * the next upgrade can say which version to go back to. */
function versionPath(): string {
  return `${appDbPath()}.version`;
}

async function lastVersion(): Promise<string | null> {
  try {
    return (await readTextFile(versionPath())).trim() || null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** The pid holding the database lock, or `undefined` when nothing live does. */
export async function liveLockPid(): Promise<number | undefined> {
  let pid: number | undefined;
  try {
    pid = Number((await readTextFile(lockPath())).trim());
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return pid !== undefined && Number.isInteger(pid) && isProcessAlive(pid)
    ? pid
    : undefined;
}

/** A PID file next to the database is the lock: a live PID inside it
 * refuses a second start, a dead one is taken over silently. */
async function acquireLock(): Promise<void> {
  const path = lockPath();
  const existingPid = await liveLockPid();
  if (existingPid !== undefined) {
    // Says what is holding the database, what to do about it, and offers the
    // path that does not need another process. CORE-12.
    throw new CliError(
      "serve_already_running",
      `A co-maintainer serve process (pid ${existingPid}) is using this data directory.`,
      "Stop it, or run sync from its dashboard.",
      EXIT_USAGE,
    );
  }
  await writeTextFile(path, String(process.pid));
}

export async function releaseLock(): Promise<void> {
  await remove(lockPath()).catch(() => {});
}

/** A database already at a migration this binary does not know about means
 * an older release started against one a newer release already touched —
 * refuse loudly instead of running unfamiliar structure through old code. */
function migrate(database: Database): void {
  const current =
    database.prepare<{ user_version: number }>("PRAGMA user_version").get()
      ?.user_version ?? 0;
  if (current > migrations.length) {
    throw new Error(
      `app.db is at migration ${current}, but this build only knows ${migrations.length}. ` +
        `Installing an older release after a newer one already migrated the database is unsupported. ` +
        `Run co-maintainer rollback with the newer version installed, or restore the backup in ${backupPaths().root}/previous.`,
    );
  }
  for (let index = current; index < migrations.length; index++) {
    database.exec("BEGIN");
    try {
      for (const statement of migrations[index]) database.exec(statement);
      database.exec(`PRAGMA user_version = ${index + 1}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

let db: Database | undefined;

export function isAppDbOpen(): boolean {
  return db !== undefined;
}

function userVersion(database: Database): number {
  return (
    database.prepare<{ user_version: number }>("PRAGMA user_version").get()
      ?.user_version ?? 0
  );
}

/** A database with something to migrate is backed up first. A fresh one has
 * nothing to lose, and without a complete backup the migration does not run. */
async function backupBeforeMigration(database: Database): Promise<void> {
  const current = userVersion(database);
  if (current === 0 || current >= migrations.length) return;
  try {
    await takeBackup(backupPaths(), { from: await lastVersion(), to: VERSION });
  } catch (error) {
    throw new CliError(
      "backup_failed",
      `Could not back up the data before upgrading it: ${error instanceof Error ? error.message : String(error)}`,
      "Free some disk space or check the permissions of the data directory, then try again.",
      EXIT_RUNTIME,
    );
  }
}

/** Opens (creating and migrating if needed) the single shared `app.db`
 * connection every store module reuses. `serve` opens it for the process.
 * `init` and `remake` open it for the run when it is not already open. */
export async function openAppDb(): Promise<Database> {
  if (db) return db;
  await mkdir(appDbDir(), { recursive: true });
  await acquireLock();
  const database = new Database(appDbPath());
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  await backupBeforeMigration(database);
  migrate(database);
  // The marker only names the version to go back to. Failing to write it must
  // not stop the server, but it should not vanish silently either.
  await writeTextFile(versionPath(), VERSION).catch((error) =>
    log(
      "backup",
      `could not record the running version: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  db = database;
  return database;
}

export function getAppDb(): Database {
  if (!db) throw new Error("app.db is not open. Call openAppDb() first");
  return db;
}

export async function closeAppDb(): Promise<void> {
  db?.close();
  db = undefined;
  await releaseLock();
}
