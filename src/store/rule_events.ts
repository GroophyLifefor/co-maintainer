/** A log of guide rules a newer rule went against, written by `sync` and read
 * by the dashboard repo page. */
import type { Contradiction } from "../knowledge/rule_changes.ts";
import { getAppDb } from "./app_db.ts";

export type RuleEventRow = {
  id: number;
  repo: string;
  at: string;
  kind: string;
  rule_id: string;
  by_rule_id: string | null;
  detail_json: string;
};

export function recordContradictions(
  repo: string,
  items: Contradiction[],
  at = new Date().toISOString(),
): void {
  if (items.length === 0) return;
  const insert = getAppDb().prepare(
    `INSERT INTO rule_events (repo, at, kind, rule_id, by_rule_id, detail_json)
     VALUES (?, ?, 'contradicted', ?, ?, ?)`,
  );
  for (const item of items) {
    insert.run(
      repo,
      at,
      item.id,
      item.by,
      JSON.stringify({
        sources: item.sources,
        newest: item.newest,
        dropped: item.dropped,
      }),
    );
  }
}

/** The newest events first. */
export function listRuleEvents(repo: string, limit = 20): RuleEventRow[] {
  return getAppDb()
    .prepare(
      `SELECT * FROM rule_events WHERE repo = ? ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(repo, limit) as RuleEventRow[];
}
