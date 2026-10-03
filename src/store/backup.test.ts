import { test } from "node:test";
import { Database } from "./sqlite.ts";
import { closeAppDb, openAppDb } from "./app_db.ts";
import { migrations } from "./migrations.ts";
import {
  checkRollback,
  readBackup,
  restoreBackup,
  takeBackup,
  type BackupPaths,
} from "./backup.ts";
import { runRollback } from "../cli/commands/rollback.ts";
import { CliError } from "../cli/error.ts";
import { VERSION } from "../version.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { readFile, readTextFile, stat } from "../util/runtime.ts";

const ENV = ["CM_APP_DB", "CM_CONFIG_PATH", "LOCALAPPDATA", "XDG_CACHE_HOME"];

/** Every path the backup touches, inside one temp directory. */
function paths(): BackupPaths & { dir: string } {
  const dir = tempDirSync();
  return {
    dir,
    appDb: `${dir}/app.db`,
    cacheDb: `${dir}/cache.db`,
    config: `${dir}/config.json`,
    version: `${dir}/app.db.version`,
    root: `${dir}/backups`,
  };
}

function makeDb(path: string, value: string, version?: number): void {
  const db = new Database(path);
  db.exec("CREATE TABLE marker (value TEXT)");
  db.prepare("INSERT INTO marker VALUES (?)").run(value);
  if (version !== undefined) db.exec(`PRAGMA user_version = ${version}`);
  db.close();
}

function marker(path: string): string | undefined {
  const db = new Database(path);
  try {
    return db.prepare<{ value: string }>("SELECT value FROM marker").get()
      ?.value;
  } finally {
    db.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Runs `fn` with the app data directory, config and cache all in a temp
 * dir, so the test never reads or writes the real ones. */
async function withDataDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = tempDirSync();
  const saved = ENV.map((name) => [name, getEnv(name)] as const);
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("LOCALAPPDATA", `${dir}/cache`);
  setEnv("XDG_CACHE_HOME", `${dir}/cache`);
  try {
    await fn(dir);
  } finally {
    await closeAppDb();
    for (const [name, value] of saved) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
  }
}

/** An app.db as the previous release left it: every migration but the last. */
function oldAppDb(path: string): void {
  const db = new Database(path);
  for (let index = 0; index < migrations.length - 1; index++) {
    db.exec("BEGIN");
    for (const statement of migrations[index]!) db.exec(statement);
    db.exec(`PRAGMA user_version = ${index + 1}`);
    db.exec("COMMIT");
  }
  db.prepare(
    `INSERT INTO reviews (id, kind, repo, pr_number, job_id, scope, model, status, created_at)
     VALUES ('old', 'pr', 'a/b', 1, 'j', 'whole-pr', 'm', 'posted', '2026-01-01')`,
  ).run();
  db.close();
}

test("a backup holds consistent copies and a manifest, and restoring puts them back", async () => {
  const p = paths();
  makeDb(p.appDb, "app-before");
  makeDb(p.cacheDb, "cache-before");
  await writeTextFile(p.config, '{"ai":"openrouter"}');
  await writeTextFile(p.version, "0.5.1");
  await takeBackup(p, { from: "0.5.0", to: "0.5.1" });

  const manifest = await readBackup(p);
  if (
    manifest?.fromVersion !== "0.5.0" ||
    manifest.toVersion !== "0.5.1" ||
    manifest.files.join() !== "app.db,cache.db,config.json"
  ) {
    throw new Error(JSON.stringify(manifest));
  }
  if (marker(`${p.root}/previous/app.db`) !== "app-before") {
    throw new Error("the copied app.db lost its rows");
  }

  // The state after the upgrade, with a stale WAL next to it.
  makeDb(`${p.dir}/after.db`, "app-after");
  await writeTextFile(p.appDb, "");
  await writeTextFile(`${p.appDb}-wal`, "stale");
  await writeTextFile(p.config, '{"ai":"none"}');
  await restoreBackup(p);

  if (marker(p.appDb) !== "app-before") throw new Error("app.db not restored");
  if (marker(p.cacheDb) !== "cache-before") throw new Error("cache.db");
  if ((await readTextFile(p.config)) !== '{"ai":"openrouter"}') {
    throw new Error("config.json not restored");
  }
  if (await exists(`${p.appDb}-wal`)) throw new Error("a stale WAL survived");
  if (!(await exists(`${p.root}/rolled-back/app.db-wal`))) {
    throw new Error("the replaced files were not kept");
  }
  if (
    (await readTextFile(`${p.root}/rolled-back/config.json`)) !==
    '{"ai":"none"}'
  ) {
    throw new Error("the newer config was not kept");
  }
  if (await readBackup(p)) throw new Error("the backup was not consumed");
  if ((await readTextFile(p.version)) !== "0.5.0") {
    throw new Error("the version marker still names the upgraded version");
  }
});

test("a directory without a manifest is not a backup", async () => {
  const p = paths();
  makeDb(p.appDb, "x");
  await takeBackup(p, { from: null, to: "1" });
  await writeTextFile(`${p.root}/previous/manifest.json`, "{ not json");
  if (await readBackup(p)) throw new Error("a corrupt manifest was accepted");
  await writeTextFile(
    `${p.root}/previous/manifest.json`,
    JSON.stringify({
      fromVersion: null,
      toVersion: "1",
      createdAt: "x",
      files: ["app.db", "cache.db"],
    }),
  );
  if (await readBackup(p)) throw new Error("a missing file was accepted");
});

test("a manifest that does not name the database is not a backup", async () => {
  const p = paths();
  makeDb(p.appDb, "x");
  await takeBackup(p, { from: null, to: "1" });
  for (const bad of [
    { fromVersion: null, toVersion: "1", createdAt: "x", files: [] },
    {
      fromVersion: null,
      toVersion: "1",
      createdAt: "x",
      files: ["app.db", "../evil"],
    },
    { fromVersion: null, createdAt: "x", files: ["app.db"] },
    { toVersion: "1", createdAt: "x", files: ["app.db"] },
    { fromVersion: null, toVersion: "1", createdAt: "x", files: "app.db" },
    null,
  ]) {
    await writeTextFile(
      `${p.root}/previous/manifest.json`,
      JSON.stringify(bad),
    );
    if (await readBackup(p)) throw new Error(`accepted ${JSON.stringify(bad)}`);
  }
});

test("a new backup replaces the old one only when it completes", async () => {
  const p = paths();
  makeDb(p.appDb, "first");
  await takeBackup(p, { from: null, to: "1" });
  await takeBackup(p, { from: "1", to: "2" });
  const manifest = await readBackup(p);
  if (manifest?.toVersion !== "2") throw new Error(JSON.stringify(manifest));
  if (await exists(`${p.root}/previous.tmp`))
    throw new Error("temp left behind");
  if (await exists(`${p.root}/previous.old`))
    throw new Error("the old backup was left behind");
});

test("opening a database with a pending migration backs it up first", async () => {
  await withDataDir(async (dir) => {
    oldAppDb(`${dir}/app.db`);
    await writeTextFile(`${dir}/app.db.version`, "0.5.0-test");
    await writeTextFile(`${dir}/config.json`, "{}");
    const db = await openAppDb();
    const live = db
      .prepare<{ user_version: number }>("PRAGMA user_version")
      .get()?.user_version;
    if (live !== migrations.length) throw new Error(`live at ${live}`);

    const backup = new Database(`${dir}/backups/previous/app.db`);
    const before = backup
      .prepare<{ user_version: number }>("PRAGMA user_version")
      .get()?.user_version;
    const rows = backup
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM reviews")
      .get()?.n;
    backup.close();
    if (before !== migrations.length - 1 || rows !== 1) {
      throw new Error(`backup at ${before} with ${rows} row(s)`);
    }
    const manifest = await readBackup({
      appDb: `${dir}/app.db`,
      cacheDb: "",
      config: "",
      version: "",
      root: `${dir}/backups`,
    });
    if (
      manifest?.fromVersion !== "0.5.0-test" ||
      manifest.toVersion !== VERSION
    ) {
      throw new Error(JSON.stringify(manifest));
    }
    if ((await readTextFile(`${dir}/app.db.version`)) !== VERSION) {
      throw new Error("the running version was not recorded");
    }

    // Reopening has nothing to migrate, so the backup stays the first one.
    await closeAppDb();
    const createdAt = manifest.createdAt;
    await openAppDb();
    const again = await readBackup({
      appDb: "",
      cacheDb: "",
      config: "",
      version: "",
      root: `${dir}/backups`,
    });
    if (again?.createdAt !== createdAt)
      throw new Error("a second backup was taken");
  });
});

test("a fresh database has nothing to back up", async () => {
  await withDataDir(async (dir) => {
    await openAppDb();
    if (await exists(`${dir}/backups`)) throw new Error("backed up nothing");
  });
});

test("rollback refuses without a backup and on a version mismatch", async () => {
  const p = paths();
  makeDb(p.appDb, "x");
  let error: unknown;
  try {
    await checkRollback(p, "1");
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof CliError) || error.code !== "no_backup") {
    throw new Error(String(error));
  }
  await takeBackup(p, { from: "0", to: "1" });
  try {
    await checkRollback(p, "2");
    throw new Error("a mismatch was accepted");
  } catch (caught) {
    if (
      !(caught instanceof CliError) ||
      caught.code !== "backup_version_mismatch"
    ) {
      throw caught;
    }
    if (!/1/.test(caught.message) || !/2/.test(caught.message)) {
      throw new Error(caught.message);
    }
  }
});

test("the rollback command restores with --yes and refuses when serve is running or without confirmation", async () => {
  await withDataDir(async (dir) => {
    oldAppDb(`${dir}/app.db`);
    await openAppDb();
    await closeAppDb();

    // No terminal and no --yes: it must not restore.
    try {
      await runRollback([]);
      throw new Error("rolled back without confirmation");
    } catch (error) {
      if (
        !(error instanceof CliError) ||
        error.code !== "confirmation_required"
      ) {
        throw error;
      }
    }

    // A live process holding the lock.
    await writeTextFile(`${dir}/app.db.lock`, String(process.pid));
    try {
      await runRollback(["--yes"]);
      throw new Error("rolled back under a running serve");
    } catch (error) {
      if (
        !(error instanceof CliError) ||
        error.code !== "serve_already_running"
      ) {
        throw error;
      }
    }
    await writeTextFile(`${dir}/app.db.lock`, "999999999");

    await runRollback(["--yes"]);
    const db = new Database(`${dir}/app.db`);
    const version = db
      .prepare<{ user_version: number }>("PRAGMA user_version")
      .get()?.user_version;
    db.close();
    if (version !== migrations.length - 1) {
      throw new Error(`restored to migration ${version}`);
    }
    if (!(await exists(`${dir}/backups/rolled-back/app.db`))) {
      throw new Error("the upgraded database was not kept");
    }
    if ((await readFile(`${dir}/app.db`)).length === 0)
      throw new Error("empty");
  });
});
