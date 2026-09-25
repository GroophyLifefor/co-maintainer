/** Every webhook delivery is recorded here, whether it was acted on or not,
 * so a skipped pull request stays visible instead of silent. */
import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import type { DeliveryRow } from "./rows.ts";

export function recordDelivery(row: {
  deliveryId: string;
  event: string;
  action?: string;
  repo?: string;
  prNumber?: number;
  outcome: string;
  reason?: string;
}): void {
  getAppDb()
    .prepare(
      `INSERT INTO deliveries
       (delivery_id, event, action, repo, pr_number, received_at, outcome, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.deliveryId,
      row.event,
      row.action ?? null,
      row.repo ?? null,
      row.prNumber ?? null,
      nowIso(),
      row.outcome,
      row.reason ?? null,
    );
}

export function hasDelivery(deliveryId: string): boolean {
  return (
    getAppDb()
      .prepare(`SELECT 1 FROM deliveries WHERE delivery_id = ?`)
      .get(deliveryId) !== undefined
  );
}

export function listSkipped(repo?: string): DeliveryRow[] {
  const where = repo
    ? `WHERE outcome != 'enqueued' AND repo = ?`
    : `WHERE outcome != 'enqueued'`;
  const db = getAppDb().prepare<DeliveryRow>(
    `SELECT * FROM deliveries ${where} ORDER BY received_at DESC`,
  );
  return repo ? db.all(repo) : db.all();
}

/** The newest delivery for one repository, whatever its outcome, so a repo
 * page can say when GitHub last reached it instead of showing nothing. */
export function lastDeliveryForRepo(repo: string): DeliveryRow | undefined {
  return getAppDb()
    .prepare<DeliveryRow>(
      `SELECT * FROM deliveries WHERE repo = ? ORDER BY received_at DESC LIMIT 1`,
    )
    .get(repo);
}

/** The newest delivery of any kind, for the setup checklist's webhook step:
 * it answers "has GitHub ever reached this server" rather than "for which
 * repo". */
export function lastDelivery(): DeliveryRow | undefined {
  return getAppDb()
    .prepare<DeliveryRow>(
      `SELECT * FROM deliveries ORDER BY received_at DESC LIMIT 1`,
    )
    .get();
}
