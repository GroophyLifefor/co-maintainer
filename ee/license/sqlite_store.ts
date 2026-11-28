/** A license store on the installation's own database. Everything the license
 * runtime keeps, the install id, the file in use, the files it replaced, the
 * last state and the log of changes, lives in two small tables of `app.db`, so
 * it moves with the data and survives a restart. The tables are made here on
 * first use, so the core schema does not carry them. */
import type { DatabaseSync } from "node:sqlite";
import type { LicenseState, LicenseStatus } from "./state.ts";
import type { LicenseEvent, LicenseStore, StoredLicense } from "./runtime.ts";

const KEYS = {
  installId: "install_id",
  lastSeen: "last_seen",
  lastChecked: "last_checked",
  active: "active",
  lastGood: "last_good",
  lastStatus: "last_status",
} as const;

export function sqliteLicenseStore(
  db: DatabaseSync,
): LicenseStore & { events(): LicenseEvent[]; history(): StoredLicense[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS license_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS license_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    body TEXT NOT NULL
  )`);
  const read = <T>(key: string): T | undefined => {
    const row = db
      .prepare("SELECT value FROM license_kv WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as T);
  };
  const write = (key: string, value: unknown): void => {
    db.prepare(
      `INSERT INTO license_kv (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, JSON.stringify(value));
  };
  const logged = <T>(kind: string): T[] =>
    (
      db
        .prepare("SELECT body FROM license_log WHERE kind = ? ORDER BY id")
        .all(kind) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as T);
  const append = (kind: string, at: number, body: unknown): void => {
    db.prepare("INSERT INTO license_log (kind, at, body) VALUES (?, ?, ?)").run(
      kind,
      at,
      JSON.stringify(body),
    );
  };
  return {
    getInstallId: () => read<string>(KEYS.installId),
    setInstallId: (id) => write(KEYS.installId, id),
    getLastSeen: () => read<number>(KEYS.lastSeen),
    setLastSeen: (at) => write(KEYS.lastSeen, at),
    getLastChecked: () => read<number>(KEYS.lastChecked),
    setLastChecked: (at) => write(KEYS.lastChecked, at),
    getActive: () => read<StoredLicense>(KEYS.active),
    setActive: (file) => write(KEYS.active, file),
    pushHistory: (file) => append("history", file.loadedAt, file),
    getLastGood: () => read<LicenseState>(KEYS.lastGood),
    setLastGood: (state) => write(KEYS.lastGood, state),
    getLastStatus: () => read<LicenseStatus>(KEYS.lastStatus),
    setLastStatus: (status) => write(KEYS.lastStatus, status),
    appendEvent: (event) => append("event", event.at, event),
    events: () => logged<LicenseEvent>("event"),
    history: () => logged<StoredLicense>("history"),
  };
}
