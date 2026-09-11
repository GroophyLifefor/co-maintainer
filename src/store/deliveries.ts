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
  getAppDb().prepare(
    `INSERT INTO deliveries
       (delivery_id, event, action, repo, pr_number, received_at, outcome, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  return getAppDb().prepare(
    `SELECT 1 FROM deliveries WHERE delivery_id = ?`,
  ).get(deliveryId) !== undefined;
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
