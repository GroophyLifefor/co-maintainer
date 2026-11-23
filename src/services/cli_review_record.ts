/** A review run from the CLI, local or of a pull request, written to app.db
 * once it is over, so the dashboard's Activity list and Usage show it with
 * its cost. Next to a running `serve` it is written through a short second
 * connection (see `withAppDb`). A write that cannot happen is a warning: the
 * review itself already finished. */
import { getAppDb, withAppDb } from "../store/app_db.ts";
import { insertFinishedJob } from "../store/jobs.ts";
import { costColumns, settle, type CostTally } from "../util/cost.ts";
import { log } from "../util/log.ts";

export type CliReviewRecord = {
  /** `local` for a review of a working tree, `cli_pr` for a pull request. */
  kind: "local" | "cli_pr";
  repo: string;
  prNumber?: number;
  branch?: string;
  headSha?: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  tally: CostTally;
  findings: number;
  startedAt: string;
  durationMs: number;
  failed?: string;
};

export async function recordCliReview(record: CliReviewRecord): Promise<void> {
  try {
    const written = await withAppDb(() => {
      const jobId = crypto.randomUUID();
      insertFinishedJob({
        id: jobId,
        type: record.kind === "local" ? "review_local" : "review_cli",
        repo: record.repo,
        prNumber: record.prNumber,
        args: { source: "cli" },
        status: record.failed ? "failed" : "done",
        startedAt: record.startedAt,
        error: record.failed,
      });
      const cost = costColumns(settle(record.tally));
      getAppDb()
        .prepare(
          `INSERT INTO reviews
           (id, kind, repo, pr_number, branch, job_id, head_sha, scope, model,
            findings_count, tokens_in, tokens_out, cost, cost_status, cost_note,
            billed_to, duration_ms, status, created_at, round)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'cli', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          crypto.randomUUID(),
          record.kind,
          record.repo,
          record.prNumber ?? null,
          record.branch ?? null,
          jobId,
          record.headSha ?? null,
          record.model,
          record.findings,
          record.tokensIn,
          record.tokensOut,
          cost.cost ?? null,
          cost.cost_status ?? null,
          cost.cost_note ?? null,
          "server",
          record.durationMs,
          record.failed ? "failed" : "done",
          record.startedAt,
        );
    });
    if (!written.ok) {
      log("review", `not recorded on the dashboard: ${written.reason}`);
    }
  } catch (error) {
    log(
      "review",
      `not recorded on the dashboard: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
