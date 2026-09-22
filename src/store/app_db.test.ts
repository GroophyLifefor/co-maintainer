import { Database } from "./sqlite.ts";
import { appDbPath, closeAppDb, getAppDb, openAppDb } from "./app_db.ts";
import { migrations } from "./migrations.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { test } from "node:test";

function applyMigrationsFrom(
  db: Database,
  fromVersion: number,
  toVersion: number,
): void {
  for (let index = fromVersion; index < toVersion; index++) {
    db.exec("BEGIN");
    try {
      for (const statement of migrations[index]) db.exec(statement);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function tempDbPath(): string {
  return `${tempDirSync()}/app.db`;
}

test("openAppDb creates every table and is idempotent to reopen", async () => {
  const path = tempDbPath();
  const original = getEnv("CM_APP_DB");
  setEnv("CM_APP_DB", path);
  try {
    const db = await openAppDb();
    if (appDbPath() !== path) throw new Error("CM_APP_DB override not honored");
    const tables = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    for (const expected of [
      "deliveries",
      "drift",
      "findings",
      "installations",
      "job_logs",
      "jobs",
      "repos",
      "reviews",
      "sessions",
    ]) {
      if (!tables.includes(expected)) {
        throw new Error(`missing table ${expected}, got ${tables.join(", ")}`);
      }
    }
    const version = db
      .prepare<{ user_version: number }>("PRAGMA user_version")
      .get()?.user_version;
    if (version !== migrations.length) {
      throw new Error(
        `user_version is ${version}, expected ${migrations.length}`,
      );
    }
    await closeAppDb();

    // Reopening a fully-migrated database must not re-run migrations or throw.
    const reopened = await openAppDb();
    if (reopened !== getAppDb()) throw new Error("getAppDb out of sync");
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
  }
});

test("only one queued job per repo and PR number is allowed", async () => {
  const path = tempDbPath();
  const original = getEnv("CM_APP_DB");
  setEnv("CM_APP_DB", path);
  try {
    const db = await openAppDb();
    const insert = () =>
      db
        .prepare(
          `INSERT INTO jobs (id, type, repo, pr_number, status, created_at)
         VALUES (?, 'review', 'a/b', 1, 'queued', '2026-01-01T00:00:00.000Z')`,
        )
        .run(crypto.randomUUID());
    insert();
    let threw = false;
    try {
      insert();
    } catch {
      threw = true;
    }
    if (!threw) {
      throw new Error("a second queued job for the same PR was allowed");
    }
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
  }
});

test("a second serve process refuses to start while the first holds the lock", async () => {
  const path = tempDbPath();
  const original = getEnv("CM_APP_DB");
  setEnv("CM_APP_DB", path);
  try {
    // process.pid is genuinely alive (it's this test process), so writing it
    // into the lock file simulates another serve process already running.
    await writeTextFile(`${path}.lock`, String(process.pid));
    let threw = false;
    try {
      await openAppDb();
    } catch (error) {
      threw = true;
      // CORE-12: the message names the pid and the hint offers the next step;
      // `String(error)` only carries the message, so read both fields.
      const message = (error as { message?: string }).message ?? String(error);
      const hint = (error as { hint?: string }).hint ?? "";
      if (!message.includes(String(process.pid))) {
        throw new Error(`refusal did not name the pid: ${message}`);
      }
      if (!message.includes("is using this data directory")) {
        throw new Error(`refusal did not explain what holds it: ${message}`);
      }
      if (!hint.includes("Stop it, or run sync from its dashboard")) {
        throw new Error(`refusal did not offer the next step: ${hint}`);
      }
    }
    if (!threw) throw new Error("a held lock did not refuse the second open");
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
  }
});

test("a stale lock from a dead process is taken over automatically", async () => {
  const path = tempDbPath();
  const original = getEnv("CM_APP_DB");
  setEnv("CM_APP_DB", path);
  try {
    // A PID this high is exceedingly unlikely to be alive on any platform.
    await writeTextFile(`${path}.lock`, "999999999");
    await openAppDb();
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
  }
});

test("migration 7 keeps review rows and marks repeat findings open", () => {
  const path = tempDbPath();
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrationsFrom(db, 0, 6);
  db.prepare(
    `INSERT INTO reviews
       (id, repo, pr_number, job_id, head_sha, base_sha, scope, model,
        findings_count, tokens_in, tokens_out, status, created_at, round)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'posted', ?, 1)`,
  ).run(
    "rev-old",
    "acme/widgets",
    1,
    "job-1",
    "head1",
    "base1",
    "whole-pr",
    "fake",
    "2026-01-01T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO findings
       (id, review_id, severity, path, line_from, line_to, title, body_md,
        first_seen_review_id)
     VALUES (?, ?, 'P2', 'src/a.ts', 1, 1, 't', 'b', ?)`,
  ).run("f-1", "rev-old", "rev-prev");
  applyMigrationsFrom(db, 6, 7);
  const review = db
    .prepare<{ kind: string; pr_number: number | null }>(
      "SELECT kind, pr_number FROM reviews WHERE id = ?",
    )
    .get("rev-old");
  const finding = db
    .prepare<{ state: string }>("SELECT state FROM findings WHERE id = ?")
    .get("f-1");
  const tables = db
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    )
    .all()
    .map((row: { name: string }) => row.name);
  db.close();
  if (review?.kind !== "pr" || review.pr_number !== 1) {
    throw new Error(`review not preserved: ${JSON.stringify(review)}`);
  }
  if (finding?.state !== "open") {
    throw new Error(`repeat finding state: ${JSON.stringify(finding)}`);
  }
  if (!tables.includes("subjects") || !tables.includes("subject_revisions")) {
    throw new Error(`missing carry-over tables: ${tables.join(", ")}`);
  }
});

test("a database newer than this binary's migrations refuses to start", async () => {
  const path = tempDbPath();
  const original = getEnv("CM_APP_DB");
  setEnv("CM_APP_DB", path);
  try {
    const db = await openAppDb();
    db.exec(`PRAGMA user_version = ${migrations.length + 1}`);
    await closeAppDb();
    let threw = false;
    try {
      await openAppDb();
    } catch (error) {
      threw = true;
      if (!String(error).includes("only knows")) {
        throw new Error("refusal did not explain why");
      }
    }
    if (!threw) throw new Error("a newer database did not refuse to open");
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
  }
});
