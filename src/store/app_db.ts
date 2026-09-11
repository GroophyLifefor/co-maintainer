import { Database } from "@db/sqlite";
import { getCacheDir } from "../config.ts";
import { migrations } from "./migrations.ts";

export function appDbDir(): string {
  return `${getCacheDir()}/co-maintainer`;
}

/** `CM_APP_DB` overrides the path — tests point it at a temp file. */
export function appDbPath(): string {
  return Deno.env.get("CM_APP_DB") ?? `${appDbDir()}/app.db`;
}

function lockPath(): string {
  return `${appDbPath()}.lock`;
}

/** `Deno.kill` has no signal that only checks a process on Windows: the
 * ones that report a dead PID as `NotFound` (SIGTERM, SIGKILL, SIGINT...)
 * really do terminate a live one there, and SIGCONT, the safe POSIX check,
 * is not a signal Windows recognizes at all. `tasklist` answers the same
 * question without touching the process. */
async function isAliveOnWindows(pid: number): Promise<boolean> {
  const command = new Deno.Command("tasklist", {
    args: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  return new TextDecoder().decode(result.stdout).trim().startsWith('"');
}

async function isAlive(pid: number): Promise<boolean> {
  if (Deno.build.os === "windows") return isAliveOnWindows(pid);
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    // Permission denied checking another user's process, or the signal is
    // unsupported on this platform — assume alive rather than risk two
    // writers on the same app.db.
    return true;
  }
}

/** A PID file next to the database is the lock: a live PID inside it
 * refuses a second start, a dead one is taken over silently. */
async function acquireLock(): Promise<void> {
  const path = lockPath();
  let existingPid: number | undefined;
  try {
    existingPid = Number((await Deno.readTextFile(path)).trim());
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (
    existingPid !== undefined && Number.isInteger(existingPid) &&
    await isAlive(existingPid)
  ) {
    throw new Error(
      `co-maintainer serve is already running (pid ${existingPid}) against this app.db. Only one serve process may write to it at a time.`,
    );
  }
  await Deno.writeTextFile(path, String(Deno.pid));
}

export async function releaseLock(): Promise<void> {
  await Deno.remove(lockPath()).catch(() => {});
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
        `Installing an older release after a newer one already migrated the database is unsupported.`,
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

/** Opens (creating and migrating if needed) the single shared `app.db`
 * connection every store module reuses. Call once at `serve` startup. */
export async function openAppDb(): Promise<Database> {
  if (db) return db;
  await Deno.mkdir(appDbDir(), { recursive: true });
  await acquireLock();
  const database = new Database(appDbPath());
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  db = database;
  return database;
}

export function getAppDb(): Database {
  if (!db) throw new Error("app.db is not open; call openAppDb() first");
  return db;
}

export async function closeAppDb(): Promise<void> {
  db?.close();
  db = undefined;
  await releaseLock();
}
