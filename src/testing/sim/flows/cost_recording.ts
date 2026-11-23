/** Every run that spends money is on the dashboard with what it spent: a
 * knowledge build from the CLI, an App review, a pull request review run from
 * the CLI. Usage, the job page and the CSV read the same rows, and clearing
 * knowledge leaves the spend history alone.
 *
 * The checks read app.db and the pages, never the model's answer, so a real
 * model passes them too. */
import type { AiRule } from "../fake_ai.ts";
import {
  check,
  defineFlow,
  scriptedCheck,
  type CheckResult,
  type Sim,
} from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, OPENED_MATH, appRows, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";
import { aiFlags } from "./cli_pr.ts";
import { NO_CODEGRAPH, makeCheckout, runReview } from "./local.ts";

const STEP = {
  built: "init from the CLI, then serve",
  appReview: "an App review",
  cliReview: "a pull request review from the CLI",
  failedLocal: "a local review that fails after a paid round",
  pages: "Usage, the job page and the CSV read the same spend",
  cleared: "clearing the cache keeps the spend history",
};

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "any review",
    job: "review_pull_request",
    prompt: /[\s\S]*/,
    reply: { findings: [] },
  },
  {
    // The first round is paid and asks for a tool, the second fails, so the
    // review fails after it already spent money.
    name: "local review failing after a paid round",
    job: "review_local",
    prompt: /[\s\S]*/,
    reply: (call) =>
      call.round === 0
        ? {
            toolCalls: [
              {
                name: "read-mermaid-syntaxes",
                arguments: { tools: ["flowchart"] },
              },
            ],
          }
        : { error: 401, message: "the key was revoked" },
  },
];

type CostRow = { kind: string; job_id: string | null; source: string };

function checks(sim: Sim): CheckResult[] {
  const state = sim.state as Record<string, Record<string, unknown>>;
  const built = state.built ?? {};
  const cli = state.cliReview ?? {};
  const failedLocal = state.failedLocal ?? {};
  const pages = state.pages ?? {};
  const cleared = state.cleared ?? {};
  return [
    check(
      "an init run from the CLI writes one finished job row, not a queued or running one",
      built.jobStatus === "done" && built.jobSource === "cli",
      `job ${String(built.jobStatus)} · source ${String(built.jobSource)}`,
    ),
    check(
      "every AI call of that init is in ai_costs as knowledge spend, tied to its job",
      Number(built.costRows) > 0 &&
        built.allKnowledge === true &&
        built.allOnJob === true,
      `${String(built.costRows)} rows · knowledge ${String(built.allKnowledge)} · on the job ${String(built.allOnJob)}`,
    ),
    check(
      "a pull request review from the CLI writes a finished job and a review row",
      cli.jobType === "review_cli" &&
        cli.reviewKind === "cli_pr" &&
        cli.reviewStatus === "done",
      JSON.stringify(cli),
    ),
    scriptedCheck(
      sim,
      "a local review that fails after a paid round writes a failed job and a failed review row with its cost",
      failedLocal.exit !== 0 &&
        failedLocal.jobType === "review_local" &&
        failedLocal.jobStatus === "failed" &&
        failedLocal.reviewStatus === "failed" &&
        Number(failedLocal.tokensIn) > 0,
      JSON.stringify(failedLocal),
      "only the fake AI fails a call on purpose",
    ),
    check(
      "Usage prices init and sync instead of saying Not recorded, and lists CLI reviews",
      pages.notRecorded === false &&
        pages.cliRow === true &&
        pages.knowledgeRow === true,
      JSON.stringify(pages),
    ),
    check(
      "the init job page shows a cost, not Cost unknown",
      pages.jobCostKnown === true,
      `cost known ${String(pages.jobCostKnown)}`,
    ),
    check(
      "the CSV has the kind column and a knowledge row next to the review rows",
      pages.csvKind === true && pages.csvKnowledge === true,
      `kind column ${String(pages.csvKind)} · knowledge row ${String(pages.csvKnowledge)}`,
    ),
    check(
      "the Pull requests tab lists no row without a pull request number",
      pages.nullRow === false,
      `a #null row ${String(pages.nullRow)}`,
    ),
    check(
      "clearing knowledge with the cache keeps every ai_costs row",
      cleared.before === cleared.after && Number(cleared.before) > 0,
      `before ${String(cleared.before)} · after ${String(cleared.after)}`,
    ),
  ];
}

export default defineFlow({
  name: "cost-recording",
  description:
    "every run that spends money is on the dashboard with its spend: CLI init, App review, CLI pull request review",
  ai: AI,
  steps: [
    {
      name: STEP.built,
      async run(sim) {
        // serveRepo runs init before serve starts, the way a CLI init does.
        await serveRepo(sim);
        const job = appRows<{ id: string; status: string; args: string }>(
          sim,
          "SELECT id, status, args FROM jobs WHERE type = 'init' AND repo = ?",
          APP_REPO,
        )[0];
        const rows = appRows<CostRow>(
          sim,
          "SELECT kind, job_id, source FROM ai_costs WHERE repo = ?",
          APP_REPO,
        );
        sim.state.built = {
          jobStatus: job?.status,
          jobSource: job
            ? (JSON.parse(job.args) as { source?: string }).source
            : undefined,
          costRows: rows.length,
          allKnowledge: rows.every((row) => row.kind === "knowledge"),
          allOnJob: rows.every((row) => row.job_id === job?.id),
          jobId: job?.id,
        };
        return JSON.stringify(sim.state.built);
      },
    },
    {
      name: STEP.appReview,
      async run(sim) {
        const pull: SimPull = sim.github.openPull(APP_REPO, {
          title: "Add divide and average",
          files: { "src/math.ts": OPENED_MATH },
        });
        sim.state.pull = pull;
        await sim.server.deliver(
          "pull_request",
          sim.server.payloads.pullRequest(pull, "opened"),
        );
        const jobs = await sim.server.runJobs();
        return jobs.map((job) => `${job.type} ${job.status}`).join(", ");
      },
    },
    {
      name: STEP.cliReview,
      async run(sim) {
        const pull = sim.state.pull as SimPull;
        await sim.cli([
          "review",
          APP_REPO,
          String(pull.number),
          ...aiFlags(sim),
        ]);
        const row = appRows<{ type: string; kind: string; status: string }>(
          sim,
          `SELECT j.type AS type, r.kind AS kind, r.status AS status
           FROM reviews r INNER JOIN jobs j ON j.id = r.job_id
           WHERE r.kind = 'cli_pr' AND r.repo = ?`,
          APP_REPO,
        )[0];
        sim.state.cliReview = {
          jobType: row?.type,
          reviewKind: row?.kind,
          reviewStatus: row?.status,
        };
        return JSON.stringify(sim.state.cliReview);
      },
    },
    {
      name: STEP.failedLocal,
      async run(sim) {
        const checkout = makeCheckout(sim, {
          name: "failed-local",
          branch: "feature/failed-local",
          committed: { "src/limit.ts": "export const LIMIT = 10;\n" },
        });
        const run = await runReview(sim, checkout, STEP.failedLocal, [
          "--json",
          NO_CODEGRAPH,
          ...aiFlags(sim),
        ]);
        const row = appRows<{
          type: string;
          job_status: string;
          status: string;
          tokens_in: number;
        }>(
          sim,
          `SELECT j.type AS type, j.status AS job_status, r.status AS status,
                  r.tokens_in AS tokens_in
           FROM reviews r INNER JOIN jobs j ON j.id = r.job_id
           WHERE r.kind = 'local' AND r.repo = ?
           ORDER BY r.created_at DESC LIMIT 1`,
          APP_REPO,
        )[0];
        sim.state.failedLocal = {
          exit: run.cli.exitCode,
          jobType: row?.type,
          jobStatus: row?.job_status,
          reviewStatus: row?.status,
          tokensIn: row?.tokens_in,
        };
        return JSON.stringify(sim.state.failedLocal);
      },
    },
    {
      name: STEP.pages,
      async run(sim) {
        const { statsForRange, usageExportRows } =
          await import("../../../services/dashboard.ts");
        const { renderAnalytics } =
          await import("../../../server/pages/analytics.ts");
        const { usageCsv } = await import("../../../server/pages/usage_csv.ts");
        const { aiCostForJob } = await import("../../../store/ai_costs.ts");
        const { listPullSummaries } = await import("../../../store/reviews.ts");
        const html = await renderAnalytics(
          "sim",
          { range: "30d" },
          statsForRange("30d"),
        ).text();
        const csv = usageCsv(usageExportRows("30d"));
        const jobId = String(
          (sim.state.built as { jobId?: string } | undefined)?.jobId ?? "",
        );
        const spent = jobId ? aiCostForJob(jobId) : undefined;
        const pulls = listPullSummaries(APP_REPO, 50, 0).items;
        sim.state.pages = {
          notRecorded: html.includes("Not recorded"),
          knowledgeRow: html.includes("init / sync"),
          cliRow: html.includes("Local and pull request reviews from the CLI"),
          jobCostKnown: spent !== undefined && spent.unknownCount === 0,
          csvKind: csv.split("\r\n")[0]!.includes(",kind,"),
          csvKnowledge: csv.includes(",knowledge,"),
          nullRow: pulls.some((row) => row.pr_number === null),
        };
        return JSON.stringify(sim.state.pages);
      },
    },
    {
      name: STEP.cleared,
      async run(sim) {
        const count = () =>
          appRows<{ n: number }>(sim, "SELECT COUNT(*) AS n FROM ai_costs")[0]
            ?.n ?? 0;
        const before = count();
        const { cacheDeleteRepoEvidence } =
          await import("../../../store/cache_db.ts");
        await cacheDeleteRepoEvidence(APP_REPO);
        const after = count();
        sim.state.cleared = { before, after };
        return `before ${before} · after ${after}`;
      },
    },
  ],
  checks,
});
