/** AI spend that is not a review: knowledge builds (init and sync), replies
 * and watch comments. Reviews keep their cost on their own row in `reviews`,
 * so nothing here is counted twice. */
import { getAppDb } from "./app_db.ts";
import type { CostTotals } from "./reviews.ts";

export type AiCostKind = "knowledge" | "reply" | "watch";

/** Which kind a product AI job belongs to, or undefined for a review job,
 * whose cost is on its review row. */
export function aiCostKindOf(job: string): AiCostKind | undefined {
  if (job === "reply_to_github_comment") return "reply";
  if (job === "watch_comment") return "watch";
  if (job.startsWith("review") || job === "remote_review") return undefined;
  return "knowledge";
}

export function insertAiCost(row: {
  repo: string;
  jobId?: string;
  kind: AiCostKind;
  job: string;
  provider?: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
  source: "server" | "cli";
}): void {
  getAppDb()
    .prepare(
      `INSERT INTO ai_costs
       (at, repo, job_id, kind, job, provider, model, tokens_in, tokens_out, cost_usd, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      row.repo,
      row.jobId ?? null,
      row.kind,
      row.job,
      row.provider ?? null,
      row.model ?? null,
      row.tokensIn,
      row.tokensOut,
      row.costUsd ?? null,
      row.source,
    );
}

/** Points the rows a CLI run wrote at the job row written for it. */
export function attachAiCostsToJob(
  repo: string,
  sinceIso: string,
  jobId: string,
): void {
  getAppDb()
    .prepare(
      `UPDATE ai_costs SET job_id = ? WHERE repo = ? AND job_id IS NULL AND source = 'cli' AND at >= ?`,
    )
    .run(jobId, repo, sinceIso);
}

/** The same six figures a review row gives, so they add to the same totals.
 * Every row is billed to the server: these jobs never take a client key. */
const COLUMNS = `COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd END), 0) AS cost,
      COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 END), 0) AS knownCount,
      COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 END), 0) AS unknownCount,
      0 AS byokUsd, 0 AS byokKnownCount, 0 AS byokUnknownCount,
      COALESCE(SUM(tokens_in), 0) AS tokensIn,
      COALESCE(SUM(tokens_out), 0) AS tokensOut,
      COUNT(DISTINCT COALESCE(job_id, at)) AS runs`;

export type AiCostTotals = CostTotals & {
  tokensIn: number;
  tokensOut: number;
  /** Jobs, or single calls for rows with no job. */
  runs: number;
};

function asTotals(row: Partial<AiCostTotals> | undefined): AiCostTotals {
  return {
    cost: Number(row?.cost ?? 0),
    knownCount: Number(row?.knownCount ?? 0),
    unknownCount: Number(row?.unknownCount ?? 0),
    byokUsd: 0,
    byokKnownCount: 0,
    byokUnknownCount: 0,
    tokensIn: Number(row?.tokensIn ?? 0),
    tokensOut: Number(row?.tokensOut ?? 0),
    runs: Number(row?.runs ?? 0),
  };
}

/** None of these rows has a pull request author, so an author filter leaves
 * every one of them out, the way it leaves out CLI reviews. */
function where(
  sinceIso: string,
  scope: { repo?: string; author?: string },
  untilIso?: string,
): { sql: string; params: string[] } {
  const clauses = ["at >= ?"];
  const params = [sinceIso];
  if (untilIso) {
    clauses.push("at < ?");
    params.push(untilIso);
  }
  if (scope.repo) {
    clauses.push("repo = ?");
    params.push(scope.repo);
  }
  if (scope.author) clauses.push("0");
  return { sql: clauses.join(" AND "), params };
}

export function aiCostTotals(
  sinceIso: string,
  scope: { repo?: string; author?: string } = {},
  untilIso?: string,
): AiCostTotals {
  const w = where(sinceIso, scope, untilIso);
  return asTotals(
    getAppDb()
      .prepare<AiCostTotals>(`SELECT ${COLUMNS} FROM ai_costs WHERE ${w.sql}`)
      .get(...w.params),
  );
}

export function aiCostsByKind(
  sinceIso: string,
  scope: { repo?: string; author?: string } = {},
): (AiCostTotals & { kind: AiCostKind })[] {
  const w = where(sinceIso, scope);
  const rows = getAppDb()
    .prepare<AiCostTotals & { kind: AiCostKind }>(
      `SELECT kind, ${COLUMNS} FROM ai_costs WHERE ${w.sql} GROUP BY kind`,
    )
    .all(...w.params);
  return (["knowledge", "reply", "watch"] as const).map((kind) => ({
    ...asTotals(rows.find((row) => row.kind === kind)),
    kind,
  }));
}

export function aiCostsBy(
  column: "repo" | "model" | "day",
  sinceIso: string,
  scope: { repo?: string; author?: string } = {},
): (AiCostTotals & { key: string })[] {
  const w = where(sinceIso, scope);
  const key =
    column === "day" ? "substr(at, 1, 10)" : `COALESCE(${column}, 'unknown')`;
  return getAppDb()
    .prepare<AiCostTotals & { key: string }>(
      `SELECT ${key} AS key, ${COLUMNS} FROM ai_costs WHERE ${w.sql} GROUP BY 1`,
    )
    .all(...w.params)
    .map((row) => ({ ...asTotals(row), key: row.key }));
}

/** One job's spend, for its page. */
export function aiCostForJob(jobId: string): AiCostTotals | undefined {
  const row = getAppDb()
    .prepare<AiCostTotals>(`SELECT ${COLUMNS} FROM ai_costs WHERE job_id = ?`)
    .get(jobId);
  const totals = asTotals(row);
  return totals.knownCount + totals.unknownCount > 0 ? totals : undefined;
}

export type AiCostExportRow = {
  at: string;
  repo: string;
  kind: AiCostKind;
  job_id: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  calls: number;
};

/** One row per job (or per call with no job), for the CSV. */
export function listAiCostsForExport(
  sinceIso: string,
  scope: { repo?: string; author?: string } = {},
): AiCostExportRow[] {
  const w = where(sinceIso, scope);
  return getAppDb()
    .prepare<AiCostExportRow>(
      `SELECT MIN(at) AS at, repo, kind, job_id, MAX(model) AS model,
        SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
        CASE WHEN SUM(cost_usd IS NULL) > 0 THEN NULL ELSE SUM(cost_usd) END AS cost_usd,
        COUNT(*) AS calls
       FROM ai_costs WHERE ${w.sql}
       GROUP BY COALESCE(job_id, id), repo, kind
       ORDER BY MIN(at) DESC`,
    )
    .all(...w.params);
}
