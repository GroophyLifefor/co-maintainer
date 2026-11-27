/** A small load run for the load test design: many pull requests arrive at
 * once, the product's own worker loop runs them with its own concurrency, and
 * the flow reports how long they took. It runs only when named:
 * `--flow=load`, with `LOAD_PRS` pull requests (default 20, the design run uses 100), `LOAD_AI_MS`
 * of model latency per review (default 200 ms) and `LOAD_JOBS` concurrent
 * jobs (default the product's own). `LOAD_BUDGET` gives the installation that
 * many GitHub requests an hour and resets the hour whenever the product holds
 * every review back, and a check says no hour went over it. The fake AI costs
 * nothing.
 * It asserts that every pull request got exactly one review and no job
 * failed, and reports the numbers in the check's detail. */
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, appRows, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const PRS = Number(process.env.LOAD_PRS ?? 20);
const AI_MS = Number(process.env.LOAD_AI_MS ?? 200);
/** `LOAD_BUDGET`: GitHub's requests an hour for the installation. Unset, the
 * fake GitHub has no limit. Set, the run spends it, waits when the product
 * holds reviews back, and each time it stalls the hour resets, so a run of
 * thousands of pull requests shows how many hours of budget they take. */
/** `LOAD_BURST`: how many webhooks are delivered at the same moment. Unset,
 * they arrive one after another. GitHub waits ten seconds for an answer, so
 * the slowest answer of a burst must stay under that. */
function burstFromEnv(): number | undefined {
  const raw = process.env.LOAD_BURST;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `LOAD_BURST must be a whole number of 1 or more, got "${raw}"`,
    );
  }
  return value;
}
const BURST = burstFromEnv();
/** GitHub gives up on a webhook that has not been answered in this time. */
const WEBHOOK_LIMIT_MS = 10_000;

function budgetFromEnv(): number | undefined {
  const raw = process.env.LOAD_BUDGET;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  // A value that is set but empty or not a positive number is a mistake, not
  // "no budget": say so instead of running without the check.
  if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `LOAD_BUDGET must be a positive number of requests an hour, got "${raw}"`,
    );
  }
  return value;
}
const BUDGET = budgetFromEnv();
const JOBS = process.env.LOAD_JOBS ? Number(process.env.LOAD_JOBS) : undefined;

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "any review",
    job: "review_pull_request",
    prompt: /[\s\S]*/,
    reply: { findings: [] },
  },
];

type Result = {
  wallMs: number;
  reviews: number;
  failed: number;
  githubCalls: number;
  peakQueued: number;
  jobsLimit: number;
  /** The slowest webhook answer, and how many were delivered. */
  slowestAnswerMs: number;
  delivered: number;
  /** The process's memory at the start, the highest and at the end, in MB, and
   * how many log lines say the database was locked. */
  rssStartMb: number;
  rssPeakMb: number;
  rssEndMb: number;
  lockMessages: number;
  /** Hours of the budget the run used, and the most requests any one hour
   * took. Both 0 without a budget. */
  hours: number;
  mostInAnHour: number;
};

async function drain(sim: Sim): Promise<Result> {
  const { startWorkerLoop, stopWorkerLoop } =
    await import("../../../services/jobs.ts");
  const { listJobs } = await import("../../../store/jobs.ts");
  const { readConfig } = await import("../../../config.ts");
  const startedAt = performance.now();
  let peakQueued = 0;
  let hours = BUDGET === undefined ? 0 : 1;
  let mostInAnHour = 0;
  let callsAtHourStart = sim.trace.github.length;
  let lastProgress = performance.now();
  let lastDone = -1;
  const mb = () => Math.round(process.memoryUsage().rss / 1_048_576);
  const rssStartMb = mb();
  let rssPeakMb = rssStartMb;
  startWorkerLoop(25);
  for (;;) {
    const queued = listJobs({ status: "queued" }).length;
    const running = listJobs({ status: "running" }).length;
    peakQueued = Math.max(peakQueued, queued);
    rssPeakMb = Math.max(rssPeakMb, mb());
    if (queued === 0 && running === 0) break;
    const done = listJobs({ status: "done" }).length;
    if (done !== lastDone) {
      lastDone = done;
      lastProgress = performance.now();
    }
    // Nothing runs and nothing has finished for a while: the product is
    // holding reviews back for the budget. The hour resets.
    if (
      BUDGET !== undefined &&
      running === 0 &&
      queued > 0 &&
      performance.now() - lastProgress > 1000 &&
      sim.github.budget
    ) {
      const used = sim.trace.github.length - callsAtHourStart;
      mostInAnHour = Math.max(mostInAnHour, used);
      callsAtHourStart = sim.trace.github.length;
      hours++;
      sim.github.budget = {
        limit: BUDGET,
        remaining: BUDGET,
        resetAt: Math.floor(Date.now() / 1000) + 3600 * hours,
      };
      const { resetBudgetsForTest } = await import("../../../github/budget.ts");
      resetBudgetsForTest();
      lastProgress = performance.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  mostInAnHour = Math.max(
    mostInAnHour,
    sim.trace.github.length - callsAtHourStart,
  );
  await stopWorkerLoop();
  const jobs = listJobs();
  return {
    wallMs: Math.round(performance.now() - startedAt),
    reviews: jobs.filter((j) => j.type === "review" && j.status === "done")
      .length,
    failed: jobs.filter((j) => j.status === "failed").length,
    githubCalls: sim.trace.github.length,
    peakQueued,
    jobsLimit: readConfig().maxConcurrentJobs ?? 4,
    hours,
    mostInAnHour,
    ...((sim.state.arrival as {
      slowestAnswerMs: number;
      delivered: number;
    }) ?? {
      slowestAnswerMs: 0,
      delivered: 0,
    }),
    rssStartMb,
    rssPeakMb,
    rssEndMb: mb(),
    lockMessages: appRows<{ n: number }>(
      sim,
      `SELECT COUNT(*) AS n FROM job_logs WHERE message LIKE '%locked%' OR message LIKE '%SQLITE_BUSY%'`,
    )[0]!.n,
  };
}

function checks(sim: Sim): CheckResult[] {
  const r = sim.state.result as Result;
  const perHour = Math.round((r.reviews / r.wallMs) * 3_600_000);
  return [
    check(
      `${PRS} pull requests: each gets one review and no job fails`,
      PRS > 0 && r.reviews === PRS && r.failed === 0,
      `${r.reviews} reviews · ${r.failed} failed · ${r.wallMs} ms wall · ${perHour} reviews/hour at ${AI_MS} ms of model time · ${r.githubCalls} GitHub calls (${(r.githubCalls / PRS).toFixed(1)} per pull request) · peak queue ${r.peakQueued} · concurrent jobs ${r.jobsLimit}`,
    ),
    check(
      "no database lock error in the jobs' logs",
      r.lockMessages === 0,
      `${r.lockMessages} log lines · memory ${r.rssStartMb} MB at the start, ${r.rssPeakMb} MB at the most, ${r.rssEndMb} MB at the end`,
    ),
    ...(BURST === undefined
      ? []
      : [
          check(
            `${BURST} webhooks at the same moment are all answered in under ${WEBHOOK_LIMIT_MS / 1000} seconds`,
            r.slowestAnswerMs < WEBHOOK_LIMIT_MS,
            `the slowest answer took ${r.slowestAnswerMs} ms of ${r.delivered} webhooks`,
          ),
        ]),
    ...(BUDGET === undefined
      ? []
      : [
          check(
            `with ${BUDGET} requests an hour no hour goes over the budget`,
            r.mostInAnHour <= BUDGET,
            `${r.hours} hours of budget · the busiest hour made ${r.mostInAnHour} requests`,
          ),
        ]),
  ];
}

export default defineFlow({
  name: "load",
  description:
    "many pull requests at once through the product's worker loop with a fake model that takes a set time, reporting the throughput",
  ai: AI,
  onlyWhenNamed: true,
  steps: [
    {
      name: "serve",
      async run(sim) {
        await serveRepo(sim);
        if (JOBS !== undefined)
          sim.world.writeConfig({ maxConcurrentJobs: JOBS });
        if (BUDGET !== undefined) {
          sim.github.budget = {
            limit: BUDGET,
            remaining: BUDGET,
            resetAt: Math.floor(Date.now() / 1000) + 3600,
          };
        }
        return "served";
      },
    },
    {
      name: "arrive",
      async run(sim) {
        sim.faults.add({
          target: "ai",
          kind: "slow",
          ms: AI_MS,
          job: "review_pull_request",
          times: PRS,
        });
        const pulls: SimPull[] = [];
        for (let i = 0; i < PRS; i++) {
          pulls.push(
            sim.github.openPull(APP_REPO, {
              title: `Change ${i}`,
              files: { [`docs/n${i}.md`]: `# ${i}\n` },
            }),
          );
        }
        let slowest = 0;
        const deliverOne = async (i: number) => {
          const startedAt = performance.now();
          await sim.server.deliver(
            "pull_request",
            sim.server.payloads.pullRequest(pulls[i]!, "opened"),
            { deliveryId: `load-${i}` },
          );
          slowest = Math.max(slowest, performance.now() - startedAt);
        };
        // A burst delivers its webhooks at the same moment, one burst after
        // another. Without one they arrive in turn.
        const size = BURST ?? 1;
        for (let from = 0; from < PRS; from += size) {
          await Promise.all(
            Array.from({ length: Math.min(size, PRS - from) }, (_, k) =>
              deliverOne(from + k),
            ),
          );
        }
        sim.state.arrival = {
          slowestAnswerMs: Math.round(slowest),
          delivered: PRS,
        };
        return `${PRS} webhooks delivered`;
      },
    },
    {
      name: "drain",
      async run(sim) {
        sim.state.result = await drain(sim);
        return JSON.stringify(sim.state.result);
      },
    },
  ],
  checks,
});
