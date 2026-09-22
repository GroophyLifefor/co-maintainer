import { Database } from "./sqlite.ts";
import { cacheDbPath, getCacheDir } from "../config.ts";
import { mkdirSync } from "../util/runtime.ts";

/** Paths whose schema this process has already created. Keyed by path rather
 * than a single boolean: `cacheDbPath()` reads the environment at call time
 * and tests point it at a temp directory, so a process-level flag would skip
 * `CREATE TABLE` for the second path and every query would then fail with
 * `no such table: cache`. */
const initialized = new Set<string>();

function openDatabase(): Database {
  mkdirSync(`${getCacheDir()}/co-maintainer`, { recursive: true });
  const path = cacheDbPath();
  const db = new Database(path);
  if (!initialized.has(path)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        namespace TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, cache_key)
      )
    `);
    initialized.add(path);
  }
  return db;
}

export async function cacheGet(
  namespace: string,
  key: string,
): Promise<string | undefined> {
  const db = openDatabase();
  try {
    const row = db
      .prepare<{ value: string }>(
        "SELECT value FROM cache WHERE namespace = ? AND cache_key = ?",
      )
      .get(namespace, key);
    return row?.value;
  } finally {
    db.close();
  }
}

export async function cacheSet(
  namespace: string,
  key: string,
  value: string,
): Promise<void> {
  const db = openDatabase();
  try {
    db.prepare(
      `INSERT INTO cache(namespace, cache_key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, cache_key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at`,
    ).run(namespace, key, value, new Date().toISOString());
  } finally {
    db.close();
  }
}

export async function cacheDelete(
  namespace: string,
  key: string,
): Promise<void> {
  const db = openDatabase();
  try {
    db.prepare("DELETE FROM cache WHERE namespace = ? AND cache_key = ?").run(
      namespace,
      key,
    );
  } finally {
    db.close();
  }
}

export async function cacheDeletePrefix(
  namespace: string,
  prefix: string,
): Promise<void> {
  const db = openDatabase();
  try {
    db.prepare(
      "DELETE FROM cache WHERE namespace = ? AND cache_key LIKE ?",
    ).run(namespace, `${prefix}%`);
  } finally {
    db.close();
  }
}

/** Every value under `namespace` whose key starts with `prefix`, newest first.
 * `recordAiCost` keys each job `${repo}:${uuid}`, so the probe estimate reads
 * a repository's own job history without a second index to keep in sync. */
export async function cacheValues(
  namespace: string,
  prefix: string,
): Promise<string[]> {
  const db = openDatabase();
  try {
    return db
      .prepare<{ value: string }>(
        `SELECT value FROM cache
         WHERE namespace = ? AND cache_key LIKE ?
         ORDER BY updated_at DESC`,
      )
      .all(namespace, `${prefix}%`)
      .map((row) => row.value);
  } finally {
    db.close();
  }
}
