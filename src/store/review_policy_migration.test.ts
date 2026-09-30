import { Database } from "./sqlite.ts";
import { migrations } from "./migrations.ts";
import { evaluatePolicy, legacyPolicy } from "../services/review_policy.ts";
import { tempDirSync } from "../testing/runtime.ts";
import { test } from "node:test";

function applyMigrations(db: Database, from: number, to: number): void {
  for (let index = from; index < to; index++) {
    db.exec("BEGIN");
    for (const statement of migrations[index]) db.exec(statement);
    db.exec(`PRAGMA user_version = ${index + 1}`);
    db.exec("COMMIT");
  }
}

const COMBOS = [0, 1].flatMap((auto) =>
  [0, 1].flatMap((drafts) =>
    [0, 1].map((bots) => ({
      auto_review: auto,
      skip_drafts: drafts,
      skip_bots: bots,
    })),
  ),
);

test("migration 11 pins every existing repository to the legacy policy", () => {
  const db = new Database(`${tempDirSync()}/app.db`);
  applyMigrations(db, 0, 10);
  COMBOS.forEach((combo, index) => {
    db.prepare(
      `INSERT INTO repos
       (full_name, active, auto_review, skip_drafts, skip_bots, created_at)
       VALUES (?, 1, ?, ?, ?, '2026-09-01T00:00:00.000Z')`,
    ).run(
      `acme/r${index}`,
      combo.auto_review,
      combo.skip_drafts,
      combo.skip_bots,
    );
  });
  applyMigrations(db, 10, 11);
  db.prepare(
    `INSERT INTO repos (full_name, active, created_at)
     VALUES ('acme/new', 1, '2026-09-02T00:00:00.000Z')`,
  ).run();
  const rows = db
    .prepare<{ full_name: string; review_policy_json: string | null }>(
      `SELECT full_name, review_policy_json FROM repos`,
    )
    .all();
  db.close();
  if (rows.length !== COMBOS.length + 1) throw new Error(`${rows.length} rows`);
  for (const row of rows) {
    const expected = row.full_name === "acme/new" ? null : '"legacy"';
    if (row.review_policy_json !== expected) {
      throw new Error(`${row.full_name}: ${row.review_policy_json}`);
    }
  }
});

/** What `maybeEnqueueReview` decided before policies existed, written out as
 * the reference the legacy policy has to match. */
function before(
  row: (typeof COMBOS)[number],
  facts: { draft: boolean; bot: boolean },
): { action: "skip" | "review"; reason?: string } {
  if (row.auto_review !== 1)
    return { action: "skip", reason: "auto-review-off" };
  if (row.skip_drafts === 1 && facts.draft) {
    return { action: "skip", reason: "draft" };
  }
  if (row.skip_bots === 1 && facts.bot) {
    return { action: "skip", reason: "bot-author" };
  }
  return { action: "review" };
}

test("the legacy policy decides exactly as the three switches did, for every combination", () => {
  let checked = 0;
  for (const row of COMBOS) {
    for (const draft of [false, true]) {
      for (const bot of [false, true]) {
        const wanted = before(row, { draft, bot });
        const got = evaluatePolicy(legacyPolicy(row), { draft, bot });
        const label = `${JSON.stringify(row)} draft=${draft} bot=${bot}`;
        if (got.action !== wanted.action) {
          throw new Error(`${label}: ${got.action}, wanted ${wanted.action}`);
        }
        if (wanted.action === "skip" && got.reason !== wanted.reason) {
          throw new Error(`${label}: ${got.reason}, wanted ${wanted.reason}`);
        }
        checked++;
      }
    }
  }
  if (checked !== 32) throw new Error(`checked ${checked}`);
});
