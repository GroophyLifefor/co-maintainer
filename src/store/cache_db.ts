import { Database } from "./sqlite.ts";
import { cacheDbPath, getCacheDir } from "../config.ts";
import { isNotFound, mkdirSync, stat } from "../util/runtime.ts";

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

/** Whether cache.db exists, so a `clear` that has nothing to delete does not
 * create one just to close it again. */
export async function cacheDbExists(): Promise<boolean> {
  try {
    await stat(cacheDbPath());
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Escapes LIKE's own wildcards and the escape character. A repository name
 * may contain `_`, which LIKE would otherwise read as "any character". */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
}

function deleteRows(
  db: Database,
  namespace: string,
  pattern: { exact: string } | { prefix: string },
): number {
  if ("exact" in pattern) {
    db.prepare("DELETE FROM cache WHERE namespace = ? AND cache_key = ?").run(
      namespace,
      pattern.exact,
    );
  } else {
    db.prepare(
      "DELETE FROM cache WHERE namespace = ? AND cache_key LIKE ? ESCAPE '\\'",
    ).run(namespace, likePrefix(pattern.prefix));
  }
  return db.changes;
}

/** The skill state is the repository's own knowledge, so `clear` always drops
 * it: without it the next build starts from `init` rather than `sync`. */
export async function cacheDeleteRepoKnowledge(repo: string): Promise<number> {
  const db = openDatabase();
  try {
    return deleteRows(db, "state", { exact: repo });
  } finally {
    db.close();
  }
}

/** Everything `init` fetched or paid for, kept unless the caller asked for a
 * cold next build. The global `pricing` cache stays either way. Keys live in
 * three shapes: an exact repository key, `${repo}:...`, and the local review
 * carry-over's NUL separated `${repo}\0...`. */
export async function cacheDeleteRepoEvidence(repo: string): Promise<number> {
  const db = openDatabase();
  try {
    let removed = 0;
    for (const namespace of ["pr-listing", "probe"]) {
      removed += deleteRows(db, namespace, { exact: repo });
    }
    for (const namespace of ["ai-jobs", "cost"]) {
      removed += deleteRows(db, namespace, { prefix: `${repo}:` });
    }
    removed += deleteRows(db, "local-review", { prefix: `${repo}\0` });
    return removed;
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
