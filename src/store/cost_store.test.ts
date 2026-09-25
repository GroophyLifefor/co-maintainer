import { Database } from "./sqlite.ts";
import { closeAppDb, getAppDb, openAppDb } from "./app_db.ts";
import { migrations } from "./migrations.ts";
import {
  getReview,
  insertReview,
  reviewStats,
  reviewStatsByDay,
  setReviewStatus,
} from "./reviews.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import {
  costColumns,
  emptyTally,
  addResponseCost,
  settle,
} from "../util/cost.ts";
import { test } from "node:test";

function applyMigrations(db: Database, from: number, to: number): void {
  for (let index = from; index < to; index++) {
    db.exec("BEGIN");
    for (const statement of migrations[index]) db.exec(statement);
    db.exec(`PRAGMA user_version = ${index + 1}`);
    db.exec("COMMIT");
  }
}

const OLD_ROW = `INSERT INTO reviews
  (id, kind, repo, pr_number, job_id, scope, model, status, created_at, cost)
  VALUES (?, 'pr', 'acme/widgets', 1, 'job', 'whole-pr', 'm', 'posted',
          '2026-09-01T00:00:00.000Z', ?)`;

test("migration 9 fills a 0.5.0 database: known, real zero and empty cost", () => {
  const db = new Database(`${tempDirSync()}/app.db`);
  // The 0.5.0 schema is migrations 1 to 8, so this is the file it wrote.
  applyMigrations(db, 0, 8);
  db.prepare(OLD_ROW).run("known", 0.0023);
  db.prepare(OLD_ROW).run("zero", 0);
  db.prepare(OLD_ROW).run("empty", null);
  applyMigrations(db, 8, 9);
  const rows = db
    .prepare<{
      id: string;
      cost: number | null;
      cost_status: string;
      cost_note: string | null;
      billed_to: string;
    }>("SELECT id, cost, cost_status, cost_note, billed_to FROM reviews")
    .all();
  db.close();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const known = byId.get("known");
  if (known?.cost_status !== "known" || known.cost !== 0.0023) {
    throw new Error(JSON.stringify(known));
  }
  const zero = byId.get("zero");
  if (zero?.cost_status !== "known" || zero.cost !== 0 || zero.cost_note) {
    throw new Error(`a real zero must stay known: ${JSON.stringify(zero)}`);
  }
  const empty = byId.get("empty");
  if (
    empty?.cost_status !== "unknown" ||
    empty.cost !== null ||
    empty.cost_note !== "recorded_before_0_5_1"
  ) {
    throw new Error(JSON.stringify(empty));
  }
  if (rows.some((row) => row.billed_to !== "server")) {
    throw new Error("every old row is billed to the server");
  }
});

async function withAppDb(fn: () => void | Promise<void>): Promise<void> {
  const original = getEnv("CM_APP_DB");
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
  }
}

function seed(
  id: string,
  columns: {
    cost: number | null;
    cost_status: string | null;
    billed_to?: string | null;
  },
): void {
  getAppDb()
    .prepare(
      `INSERT INTO reviews
        (id, kind, repo, pr_number, job_id, scope, model, status, created_at,
         cost, cost_status, billed_to)
       VALUES (?, 'pr', 'acme/widgets', 1, 'job', 'whole-pr', 'm', 'posted',
               '2026-09-01T00:00:00.000Z', ?, ?, ?)`,
    )
    .run(id, columns.cost, columns.cost_status, columns.billed_to ?? "server");
}

const SINCE = "2026-08-01T00:00:00.000Z";

test("totals add up known costs and count the unknown ones", async () => {
  await withAppDb(() => {
    seed("a", { cost: 0.01, cost_status: "known" });
    seed("b", { cost: 0, cost_status: "known" });
    seed("c", { cost: null, cost_status: "unknown" });
    seed("d", { cost: null, cost_status: "unknown" });
    // Written by 0.5.0 after the upgrade: no status at all.
    seed("e", { cost: 0.5, cost_status: null, billed_to: null });
    seed("f", { cost: null, cost_status: null, billed_to: null });
    const totals = reviewStats(SINCE);
    if (Math.abs(totals.cost - 0.51) > 1e-9) throw new Error(`${totals.cost}`);
    if (totals.unknownCount !== 3) {
      throw new Error(`unknown ${totals.unknownCount}`);
    }
    const day = reviewStatsByDay(SINCE)[0];
    if (day?.unknownCount !== 3 || Math.abs(day.cost - 0.51) > 1e-9) {
      throw new Error(JSON.stringify(day));
    }
  });
});

test("all known, all unknown and BYOK are kept apart", async () => {
  await withAppDb(() => {
    seed("k1", { cost: 0.25, cost_status: "known" });
    if (reviewStats(SINCE).unknownCount !== 0) throw new Error("all known");
    seed("u1", { cost: null, cost_status: "unknown" });
    seed("b1", { cost: 4, cost_status: "known", billed_to: "byok" });
    seed("b2", { cost: null, cost_status: "unknown", billed_to: "byok" });
    const totals = reviewStats(SINCE);
    if (totals.cost !== 0.25 || totals.unknownCount !== 1) {
      throw new Error(JSON.stringify(totals));
    }
    if (totals.byokUsd !== 4 || totals.byokUnknownCount !== 1) {
      throw new Error(`byok leaked: ${JSON.stringify(totals)}`);
    }
  });
  await withAppDb(() => {
    seed("u1", { cost: null, cost_status: "unknown" });
    const totals = reviewStats(SINCE);
    if (totals.cost !== 0 || totals.unknownCount !== 1) {
      throw new Error(JSON.stringify(totals));
    }
  });
});

test("a review starts as not recorded and settles to known or partial", async () => {
  await withAppDb(() => {
    const base = {
      repo: "acme/widgets",
      prNumber: 7,
      jobId: "job",
      headSha: "h",
      baseSha: "b",
      scope: "whole-pr",
      model: "m",
    };
    insertReview({ id: "r1", ...base });
    const started = getReview("r1");
    if (
      started?.cost_status !== "unknown" ||
      started.cost_note !== "not_recorded" ||
      started.billed_to !== "server"
    ) {
      throw new Error(JSON.stringify(started));
    }
    const tally = emptyTally();
    addResponseCost(tally, { cost: 0.02 });
    setReviewStatus("r1", "posted", costColumns(settle(tally)));
    const known = getReview("r1");
    if (
      known?.cost !== 0.02 ||
      known.cost_status !== "known" ||
      known.cost_note
    ) {
      throw new Error(`the old note must clear: ${JSON.stringify(known)}`);
    }

    insertReview({ id: "r2", ...base, round: 2 });
    const mixed = emptyTally();
    addResponseCost(mixed, { cost: 0.02 });
    addResponseCost(mixed, {});
    setReviewStatus("r2", "posted", costColumns(settle(mixed)));
    const partial = getReview("r2");
    if (
      partial?.cost !== null ||
      partial.cost_status !== "unknown" ||
      partial.cost_note !== "partial"
    ) {
      throw new Error(
        `partial must not store its known part: ${JSON.stringify(partial)}`,
      );
    }
  });
});
