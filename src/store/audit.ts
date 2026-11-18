/** The audit log: who did what on this server, and when. One row per action,
 * written by the places that already make the change. Secrets never reach
 * this table, the caller masks them first. */
import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";

export type AuditKind =
  | "settings"
  | "repo-settings"
  | "token"
  | "repo"
  | "sign-in"
  | "review"
  | "dismiss"
  | "update";

export const AUDIT_KINDS: AuditKind[] = [
  "settings",
  "repo-settings",
  "token",
  "repo",
  "sign-in",
  "review",
  "dismiss",
  "update",
];

/** One changed setting: its name and the old and new value as short text.
 * A secret's values are never stored, only that it changed. */
export type AuditChange = { setting: string; from: string; to: string };

export type AuditRow = {
  id: number;
  at: string;
  actor: string;
  kind: AuditKind;
  target: string | null;
  summary: string;
  changes: AuditChange[];
};

export function insertAudit(entry: {
  actor: string;
  kind: AuditKind;
  summary: string;
  target?: string;
  changes?: AuditChange[];
  at?: string;
}): void {
  getAppDb()
    .prepare(
      `INSERT INTO audit_log (at, actor, kind, target, summary, changes_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.at ?? nowIso(),
      entry.actor,
      entry.kind,
      entry.target ?? null,
      entry.summary,
      entry.changes?.length ? JSON.stringify(entry.changes) : null,
    );
}

export type AuditFilter = { kind?: AuditKind; actor?: string };

function whereOf(filter: AuditFilter): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.actor) {
    clauses.push("actor = ?");
    params.push(filter.actor);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

/** One page of the log, newest first, and how many rows match in all. */
export function listAudit(
  filter: AuditFilter,
  limit: number,
  offset: number,
): { items: AuditRow[]; total: number } {
  const db = getAppDb();
  const where = whereOf(filter);
  const total = Number(
    db
      .prepare<{
        n: number;
      }>(`SELECT COUNT(*) AS n FROM audit_log ${where.sql}`)
      .get(...where.params)?.n ?? 0,
  );
  const rows = db
    .prepare<Omit<AuditRow, "changes"> & { changes_json: string | null }>(
      `SELECT id, at, actor, kind, target, summary, changes_json FROM audit_log
       ${where.sql} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...where.params, limit, offset);
  return {
    total,
    items: rows.map(({ changes_json, ...row }) => ({
      ...row,
      changes: parseChanges(changes_json),
    })),
  };
}

function parseChanges(raw: string | null): AuditChange[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** The people the log names, for the filter. */
export function auditActors(): string[] {
  return getAppDb()
    .prepare<{
      actor: string;
    }>(`SELECT DISTINCT actor FROM audit_log ORDER BY actor COLLATE NOCASE`)
    .all()
    .map((row) => row.actor);
}
