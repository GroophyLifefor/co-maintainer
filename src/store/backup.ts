/** The safety net for an upgrade that migrates `app.db` (CORE-102b).
 *
 * A release refuses an `app.db` newer than it knows, so going back after a
 * migration cannot mean opening the new database with the old code. Instead
 * the databases and config are copied just before the migration runs, and
 * `co-maintainer rollback` puts that copy back. One slot, the previous
 * version only. Data written after the upgrade is lost by design. */
import { Database } from "./sqlite.ts";
import { CliError, EXIT_USAGE } from "../cli/error.ts";
import {
  isNotFound,
  mkdir,
  readFile,
  readTextFile,
  remove,
  rename,
  stat,
  writeFile,
  writeTextFile,
} from "../util/runtime.ts";

export type BackupPaths = {
  appDb: string;
  cacheDb: string;
  config: string;
  /** The file naming the version that last opened `app.db`. */
  version: string;
  /** Holds `previous/` and, after a rollback, `rolled-back/`. */
  root: string;
};

export type BackupManifest = {
  /** The version that ran before the upgrade, `null` when it was not recorded. */
  fromVersion: string | null;
  toVersion: string;
  createdAt: string;
  files: string[];
};

const slot = (paths: BackupPaths) => `${paths.root}/previous`;
export const rolledBackDir = (paths: BackupPaths) =>
  `${paths.root}/rolled-back`;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** `VACUUM INTO` writes a consistent copy even while the database is open. */
function copyDatabase(from: string, to: string): void {
  const source = new Database(from);
  try {
    source.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
}

/** Copies the files into `previous/`, replacing the last backup only once the
 * new one is complete, so a failure here leaves the old backup untouched. */
export async function takeBackup(
  paths: BackupPaths,
  versions: { from: string | null; to: string },
): Promise<void> {
  const temp = `${slot(paths)}.tmp`;
  await remove(temp, { recursive: true }).catch(() => {});
  await mkdir(temp, { recursive: true });
  const files = ["app.db"];
  copyDatabase(paths.appDb, `${temp}/app.db`);
  if (await exists(paths.cacheDb)) {
    copyDatabase(paths.cacheDb, `${temp}/cache.db`);
    files.push("cache.db");
  }
  if (await exists(paths.config)) {
    await writeFile(`${temp}/config.json`, await readFile(paths.config));
    files.push("config.json");
  }
  const manifest: BackupManifest = {
    fromVersion: versions.from,
    toVersion: versions.to,
    createdAt: new Date().toISOString(),
    files,
  };
  // The manifest goes last: a directory without one is not a backup.
  await writeTextFile(
    `${temp}/manifest.json`,
    JSON.stringify(manifest, null, 2),
  );
  // Swap through `.old` so the last backup survives a failed promotion.
  const old = `${slot(paths)}.old`;
  await remove(old, { recursive: true }).catch(() => {});
  const hadPrevious = await exists(slot(paths));
  if (hadPrevious) await rename(slot(paths), old);
  try {
    await rename(temp, slot(paths));
  } catch (error) {
    if (hadPrevious) await rename(old, slot(paths)).catch(() => {});
    throw error;
  }
  await remove(old, { recursive: true }).catch(() => {});
}

const KNOWN_FILES = ["app.db", "cache.db", "config.json"];

/** A manifest that names the database and only files this module writes. */
function isManifest(value: unknown): value is BackupManifest {
  const manifest = value as Partial<BackupManifest> | null;
  return (
    typeof manifest === "object" &&
    manifest !== null &&
    (manifest.fromVersion === null ||
      typeof manifest.fromVersion === "string") &&
    typeof manifest.toVersion === "string" &&
    typeof manifest.createdAt === "string" &&
    Array.isArray(manifest.files) &&
    manifest.files.includes("app.db") &&
    manifest.files.every((file) => KNOWN_FILES.includes(file))
  );
}

/** The previous backup, or `undefined` when there is none or it is incomplete. */
export async function readBackup(
  paths: BackupPaths,
): Promise<BackupManifest | undefined> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readTextFile(`${slot(paths)}/manifest.json`));
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isManifest(manifest)) return undefined;
  for (const file of manifest.files) {
    if (!(await exists(`${slot(paths)}/${file}`))) return undefined;
  }
  return manifest;
}

/** Throws the usage error a rollback refuses with, or returns the manifest. */
export async function checkRollback(
  paths: BackupPaths,
  runningVersion: string,
): Promise<BackupManifest> {
  const manifest = await readBackup(paths);
  if (!manifest) {
    throw new CliError(
      "no_backup",
      "There is no backup to roll back to.",
      "A backup is taken when an upgrade migrates the database.",
      EXIT_USAGE,
    );
  }
  if (manifest.toVersion !== runningVersion) {
    throw new CliError(
      "backup_version_mismatch",
      `The backup was taken when upgrading to ${manifest.toVersion}, but this is ${runningVersion}.`,
      `Run rollback with co-maintainer ${manifest.toVersion} installed.`,
      EXIT_USAGE,
    );
  }
  return manifest;
}

/** Moves the current files to `rolled-back/` (so a wrong rollback can be
 * undone by hand), then copies the backup into place. The WAL and shared
 * memory files go too: a stale one next to a restored database corrupts it. */
export async function restoreBackup(paths: BackupPaths): Promise<void> {
  const manifest = await readBackup(paths);
  if (!manifest) throw new Error("backup vanished before it was restored");
  const aside = rolledBackDir(paths);
  await remove(aside, { recursive: true }).catch(() => {});
  await mkdir(aside, { recursive: true });
  const targets: [string, string][] = [
    [paths.appDb, "app.db"],
    [`${paths.appDb}-wal`, "app.db-wal"],
    [`${paths.appDb}-shm`, "app.db-shm"],
    [paths.cacheDb, "cache.db"],
    [`${paths.cacheDb}-wal`, "cache.db-wal"],
    [`${paths.cacheDb}-shm`, "cache.db-shm"],
    [paths.config, "config.json"],
  ];
  for (const [path, name] of targets) {
    if (await exists(path)) await rename(path, `${aside}/${name}`);
  }
  const destinations: Record<string, string> = {
    "app.db": paths.appDb,
    "cache.db": paths.cacheDb,
    "config.json": paths.config,
  };
  for (const file of manifest.files) {
    await writeFile(
      destinations[file]!,
      await readFile(`${slot(paths)}/${file}`),
    );
  }
  // The version marker must match the data again, or the next upgrade would
  // record the wrong version to go back to.
  if (manifest.fromVersion) {
    await writeTextFile(paths.version, manifest.fromVersion);
  } else {
    await remove(paths.version).catch(() => {});
  }
  await remove(slot(paths), { recursive: true });
}
