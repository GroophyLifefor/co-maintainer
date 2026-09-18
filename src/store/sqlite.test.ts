/** The adapter promises the `@db/sqlite` surface the store layer was written
 * against, so the bind-value normalization is part of its contract and not an
 * implementation detail. */
import { Database } from "./sqlite.ts";
import { test } from "node:test";

function withDb(fn: (db: Database) => void): void {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE t (a TEXT, b TEXT)");
    fn(db);
  } finally {
    db.close();
  }
}

test("sqlite: positional undefined binds as NULL", () => {
  withDb((db) => {
    db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run("x", undefined);
    const row = db
      .prepare<{ a: string; b: string | null }>("SELECT a, b FROM t")
      .get();
    if (row?.a !== "x" || row.b !== null) {
      throw new Error(`unexpected row: ${JSON.stringify(row)}`);
    }
  });
});

test("sqlite: named-object undefined binds as NULL", () => {
  withDb((db) => {
    // Optional fields flow through `BindObject`, which explicitly permits
    // undefined, so the named path must normalize it like the positional path.
    db.prepare("INSERT INTO t (a, b) VALUES (:a, :b)").run({
      a: "x",
      b: undefined,
    });
    const row = db
      .prepare<{ a: string; b: string | null }>("SELECT a, b FROM t")
      .get();
    if (row?.a !== "x" || row.b !== null) {
      throw new Error(`unexpected row: ${JSON.stringify(row)}`);
    }
  });
});

test("sqlite: boolean binds as 0/1", () => {
  const db = new Database(":memory:");
  try {
    // INTEGER columns so the assertion is about the bound value, not about
    // SQLite's TEXT affinity converting it on the way in.
    db.exec("CREATE TABLE b (a INTEGER, b INTEGER)");
    db.prepare("INSERT INTO b (a, b) VALUES (?, ?)").run(true, false);
    const row = db
      .prepare<{ a: number; b: number }>("SELECT a, b FROM b")
      .get();
    if (row?.a !== 1 || row.b !== 0) {
      throw new Error(`unexpected row: ${JSON.stringify(row)}`);
    }
    db.prepare("INSERT INTO b (a, b) VALUES (:a, :b)").run({
      a: false,
      b: true,
    });
    const named = db
      .prepare<{ a: number; b: number }>(
        "SELECT a, b FROM b ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    if (named?.a !== 0 || named.b !== 1) {
      throw new Error(`unexpected named row: ${JSON.stringify(named)}`);
    }
  } finally {
    db.close();
  }
});

test("sqlite: changes reports the rows of the most recent run", () => {
  withDb((db) => {
    db.prepare("INSERT INTO t (a) VALUES (?)").run("one");
    if (db.changes !== 1) throw new Error(`changes ${db.changes}`);
    db.prepare("INSERT INTO t (a) VALUES (?)").run("two");
    if (db.changes !== 1) throw new Error(`changes ${db.changes}`);
  });
});
