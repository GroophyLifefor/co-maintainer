import { Database } from "@db/sqlite";
import { cacheDbPath, getCacheDir } from "../config.ts";

let initialized = false;

function openDatabase(): Database {
  Deno.mkdirSync(`${getCacheDir()}/co-maintainer`, { recursive: true });
  const db = new Database(cacheDbPath());
  if (!initialized) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        namespace TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, cache_key)
      )
    `);
    initialized = true;
  }
  return db;
}

export async function cacheGet(
  namespace: string,
  key: string,
): Promise<string | undefined> {
  const db = openDatabase();
  try {
    const row = db.prepare<{ value: string }>(
      "SELECT value FROM cache WHERE namespace = ? AND cache_key = ?",
    ).get(namespace, key);
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
    db.prepare(
      "DELETE FROM cache WHERE namespace = ? AND cache_key = ?",
    ).run(namespace, key);
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
