import { appDbPath, closeAppDb, getAppDb, openAppDb } from "./app_db.ts";
import { migrations } from "./migrations.ts";

function tempDbPath(): string {
  return `${Deno.makeTempDirSync()}/app.db`;
}

Deno.test("openAppDb creates every table and is idempotent to reopen", async () => {
  const path = tempDbPath();
  const original = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_APP_DB", path);
  try {
    const db = await openAppDb();
    if (appDbPath() !== path) throw new Error("CM_APP_DB override not honored");
    const tables = db.prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all().map((row) => row.name);
    for (
      const expected of [
        "deliveries",
        "drift",
        "findings",
        "installations",
        "job_logs",
        "jobs",
        "repos",
        "reviews",
        "sessions",
      ]
    ) {
      if (!tables.includes(expected)) {
        throw new Error(`missing table ${expected}, got ${tables.join(", ")}`);
      }
    }
    const version = db.prepare<{ user_version: number }>("PRAGMA user_version")
      .get()
      ?.user_version;
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
    if (original === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", original);
  }
});

Deno.test("only one queued job per repo and PR number is allowed", async () => {
  const path = tempDbPath();
  const original = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_APP_DB", path);
  try {
    const db = await openAppDb();
    const insert = () =>
      db.prepare(
        `INSERT INTO jobs (id, type, repo, pr_number, status, created_at)
         VALUES (?, 'review', 'a/b', 1, 'queued', '2026-01-01T00:00:00.000Z')`,
      ).run(crypto.randomUUID());
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
    if (original === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", original);
  }
});

Deno.test("a second serve process refuses to start while the first holds the lock", async () => {
  const path = tempDbPath();
  const original = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_APP_DB", path);
  try {
    // Deno.pid is genuinely alive (it's this test process), so writing it
    // into the lock file simulates another serve process already running.
    await Deno.writeTextFile(`${path}.lock`, String(Deno.pid));
    let threw = false;
    try {
      await openAppDb();
    } catch (error) {
      threw = true;
      if (!String(error).includes("already running")) {
        throw new Error("refusal did not explain why");
      }
    }
    if (!threw) throw new Error("a held lock did not refuse the second open");
  } finally {
    await closeAppDb();
    if (original === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", original);
  }
});

Deno.test("a stale lock from a dead process is taken over automatically", async () => {
  const path = tempDbPath();
  const original = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_APP_DB", path);
  try {
    // A PID this high is exceedingly unlikely to be alive on any platform.
    await Deno.writeTextFile(`${path}.lock`, "999999999");
    await openAppDb();
  } finally {
    await closeAppDb();
    if (original === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", original);
  }
});

Deno.test("a database newer than this binary's migrations refuses to start", async () => {
  const path = tempDbPath();
  const original = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_APP_DB", path);
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
    if (original === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", original);
  }
});
