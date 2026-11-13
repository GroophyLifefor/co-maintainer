/** Extension results and findings for the reviews `serve` runs: App reviews
 * and remote reviews. The dashboard reads them, and the next round of the same
 * subject compares its keyed findings against them. */
import { getAppDb } from "./app_db.ts";
import { nowIso } from "../util/time.ts";
import type {
  ExtensionFinding,
  ExtensionReport,
  PreviousExtensionFinding,
} from "../extensions/report.ts";
import type { Severity } from "../extensions/schema.ts";

export type ExtensionResultRow = {
  id: string;
  review_id: string;
  name: string;
  status: string;
  verdict: string | null;
  reason: string | null;
  markdown: string;
  data_json: string;
  extra_json: string | null;
  usage_json: string | null;
  cost: number | null;
  details: string | null;
  duration_ms: number | null;
  attempts: number;
  created_at: string;
};

export type ExtensionFindingRow = {
  id: string;
  review_id: string;
  extension: string;
  key: string | null;
  state: string;
  severity: string;
  blocking: number;
  title: string;
  body: string;
  path: string | null;
  line_from: number | null;
  line_to: number | null;
  created_at: string;
};

/** Stores one review's extensions. A rerun of the same review replaces what an
 * earlier attempt stored. */
export function saveExtensionReport(
  reviewId: string,
  report: ExtensionReport,
): void {
  const db = getAppDb();
  const at = nowIso();
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM extension_results WHERE review_id = ?`).run(
      reviewId,
    );
    db.prepare(`DELETE FROM extension_findings WHERE review_id = ?`).run(
      reviewId,
    );
    const result = db.prepare(
      `INSERT INTO extension_results
       (id, review_id, name, status, verdict, reason, markdown, data_json,
        extra_json, usage_json, cost, details, duration_ms, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of report.results) {
      result.run(
        crypto.randomUUID(),
        reviewId,
        row.name,
        row.status,
        row.verdict,
        row.reason,
        row.markdown,
        JSON.stringify(row.data),
        row.extraData === null || row.extraData === undefined
          ? null
          : JSON.stringify(row.extraData),
        row.usage ? JSON.stringify(row.usage) : null,
        row.usage?.costUsd ?? null,
        row.details,
        row.durationMs,
        row.attempts,
        at,
      );
    }
    const finding = db.prepare(
      `INSERT INTO extension_findings
       (id, review_id, extension, key, state, severity, blocking, title, body,
        path, line_from, line_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of report.findings) {
      finding.run(
        row.id,
        reviewId,
        row.extensionId,
        row.key,
        row.state,
        row.severity,
        row.blocking ? 1 : 0,
        row.title,
        row.body,
        row.path,
        row.lineFrom,
        row.lineTo,
        at,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listExtensionResults(reviewId: string): ExtensionResultRow[] {
  return getAppDb()
    .prepare<ExtensionResultRow>(
      `SELECT * FROM extension_results WHERE review_id = ? ORDER BY rowid`,
    )
    .all(reviewId);
}

export function listExtensionFindings(reviewId: string): ExtensionFindingRow[] {
  return getAppDb()
    .prepare<ExtensionFindingRow>(
      `SELECT * FROM extension_findings WHERE review_id = ? ORDER BY rowid`,
    )
    .all(reviewId);
}

function toFinding(row: ExtensionFindingRow): ExtensionFinding {
  return {
    id: row.id,
    extensionId: row.extension,
    key: row.key,
    state: row.state as ExtensionFinding["state"],
    severity: row.severity as Severity,
    blocking: row.blocking === 1,
    title: row.title,
    body: row.body,
    path: row.path,
    lineFrom: row.line_from,
    lineTo: row.line_to,
  };
}

/** The keyed findings still standing from the last review of `subjectId` in
 * which each extension returned `ok`, other than `excludeReviewId`. Only a
 * review that reached the pull request or the client counts: after a failed
 * post, the next round treats its findings as new and comments on them. */
export function previousExtensionFindings(
  subjectId: string,
  excludeReviewId: string,
): PreviousExtensionFinding[] {
  const db = getAppDb();
  const latest = db
    .prepare<{ name: string; review_id: string }>(
      `SELECT er.name AS name, er.review_id AS review_id
       FROM extension_results er
       JOIN reviews r ON r.id = er.review_id
       WHERE r.subject_id = ? AND er.review_id != ? AND er.status = 'ok'
         AND r.status IN ('posted', 'done')
       ORDER BY er.created_at DESC, er.rowid DESC`,
    )
    .all(subjectId, excludeReviewId);
  const chosen = new Map<string, string>();
  for (const row of latest) {
    if (!chosen.has(row.name)) chosen.set(row.name, row.review_id);
  }
  const previous: PreviousExtensionFinding[] = [];
  for (const [name, reviewId] of chosen) {
    const rows = db
      .prepare<ExtensionFindingRow>(
        `SELECT * FROM extension_findings
         WHERE review_id = ? AND extension = ? AND key IS NOT NULL
           AND state != 'closed'
         ORDER BY rowid`,
      )
      .all(reviewId, name);
    for (const row of rows) {
      const { state: _state, ...rest } = toFinding(row);
      previous.push(rest);
    }
  }
  return previous;
}

/** One review's extensions, as every output reads them. */
export function loadExtensionReport(reviewId: string): ExtensionReport {
  return {
    results: listExtensionResults(reviewId).map((row) => ({
      name: row.name,
      status: row.status as "ok" | "failed" | "skipped",
      verdict: row.verdict as "request_changes" | "comment" | null,
      reason: row.reason,
      markdown: row.markdown,
      findings: [],
      data: JSON.parse(row.data_json),
      extraData: row.extra_json ? JSON.parse(row.extra_json) : null,
      usage: row.usage_json ? JSON.parse(row.usage_json) : null,
      details: row.details,
      durationMs: row.duration_ms ?? 0,
      attempts: row.attempts,
    })),
    findings: listExtensionFindings(reviewId).map(toFinding),
  };
}

/** The extensions' share of a review's cost, for "review cost is total minus
 * extensions". */
export function extensionCostForReview(reviewId: string): number {
  const row = getAppDb()
    .prepare<{ total: number | null }>(
      `SELECT SUM(cost) AS total FROM extension_results WHERE review_id = ?`,
    )
    .get(reviewId);
  return row?.total ?? 0;
}

/** How many reviews of `subjectId` came before `reviewId`, for the round
 * number of a review type that keeps none of its own. */
export function earlierReviewCount(
  subjectId: string,
  reviewId: string,
): number {
  const row = getAppDb()
    .prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM reviews WHERE subject_id = ? AND id != ?`,
    )
    .get(subjectId, reviewId);
  return row?.count ?? 0;
}
