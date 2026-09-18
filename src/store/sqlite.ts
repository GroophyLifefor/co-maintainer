/** Thin compatibility layer over `node:sqlite`, preserving the `@db/sqlite`
 * surface the store layer was written against: a synchronous `Database`,
 * `prepare<T>()` generics, `.get()/.all()/.run()`, and `db.changes`.
 *
 * Three behaviours of the JSR driver must be reproduced on top of
 * `node:sqlite`:
 *  - `undefined` parameters bind as SQL NULL (node:sqlite rejects undefined)
 *  - `boolean` parameters bind as 0/1 (node:sqlite rejects booleans)
 *  - `db.changes` reports the rows modified by the most recent `run()`, which
 *    `node:sqlite` only returns from the statement call
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";

type BindValue = string | number | bigint | boolean | null | Uint8Array;
type BindObject = Record<string, BindValue | undefined>;
type Params = (BindValue | undefined)[] | [BindObject];

/** Where a `Statement` reports its modified-row count back to its owner. */
export type ChangeSink = { recordChanges: (changes: number | bigint) => void };

export class Statement<Row = Record<string, unknown>> {
  readonly #statement: StatementSync;
  readonly #sink: ChangeSink;

  constructor(statement: StatementSync, sink: ChangeSink) {
    this.#statement = statement;
    this.#sink = sink;
  }

  get(...params: Params): Row | undefined {
    return this.#statement.get(...bind(args(params))) as Row | undefined;
  }

  all(...params: Params): Row[] {
    return this.#statement.all(...bind(args(params))) as Row[];
  }

  run(...params: Params): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  } {
    const result = this.#statement.run(...bind(args(params)));
    this.#sink.recordChanges(result.changes);
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }
}

/** Normalizes call arguments: a single object binds by name, everything else
 * is a positional list. Values `node:sqlite` refuses are mapped to what it
 * accepts — `undefined` to NULL, booleans to 0/1 — on both paths, so a field
 * typed `boolean | undefined` survives a named bind too. */
function args(params: Params): (BindValue | BindObject)[] {
  if (params.length === 1 && isBindObject(params[0])) {
    const bound: BindObject = {};
    for (const [key, value] of Object.entries(params[0])) {
      bound[key] = normalize(value);
    }
    return [bound];
  }
  return (params as (BindValue | undefined)[]).map((value) => normalize(value));
}

function normalize(value: BindValue | undefined): BindValue {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function isBindObject(value: unknown): value is BindObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}

// node:sqlite's declared input union is narrower than what it accepts at
// runtime (named-parameter objects and Uint8Array blobs both work).
function bind(params: (BindValue | BindObject)[]): never[] {
  return params as never[];
}

export class Database implements ChangeSink {
  readonly #database: DatabaseSync;
  #changes = 0;

  constructor(path: string) {
    // node --test runs test files in parallel processes, and the cache/app
    // databases are shared; node:sqlite defaults to no busy timeout while
    // @db/sqlite tolerated contention. Wait rather than throw SQLITE_BUSY.
    this.#database = new DatabaseSync(path, { timeout: 5_000 });
  }

  /** Rows modified by the most recent `run()`. */
  get changes(): number {
    return this.#changes;
  }

  recordChanges(changes: number | bigint): void {
    this.#changes = Number(changes);
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  prepare<Row = Record<string, unknown>>(sql: string): Statement<Row> {
    return new Statement<Row>(this.#database.prepare(sql), this);
  }

  close(): void {
    this.#database.close();
  }
}
