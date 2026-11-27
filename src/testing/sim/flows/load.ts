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
import { APP_REPO, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const PRS = Number(process.env.LOAD_PRS ?? 20);
const AI_MS = Number(process.env.LOAD_AI_MS ?? 200);
/** `LOAD_BUDGET`: GitHub's requests an hour for the installation. Unset, the
 * fake GitHub has no limit. Set, the run spends it, waits when the product
 * holds reviews back, and each time it stalls the hour resets, so a run of
 * thousands of pull requests shows how many hours of budget they take. */
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
  startWorkerLoop(25);
  for (;;) {
    const queued = listJobs({ status: "queued" }).length;
    const running = listJobs({ status: "running" }).length;
    peakQueued = Math.max(peakQueued, queued);
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
      // Thousands of pull requests take longer than a flow step may. This flow
      // only runs when it is named.
      timeoutMs: 30 * 60_000,
      async run(sim) {
        sim.faults.add({
          target: "ai",
          kind: "slow",
          ms: AI_MS,
          job: "review_pull_request",
          times: PRS,
        });
        for (let i = 0; i < PRS; i++) {
          const pull = sim.github.openPull(APP_REPO, {
            title: `Change ${i}`,
            files: { [`docs/n${i}.md`]: `# ${i}\n` },
          });
          await sim.server.deliver(
            "pull_request",
            sim.server.payloads.pullRequest(pull, "opened"),
            { deliveryId: `load-${i}` },
          );
        }
        return `${PRS} webhooks delivered`;
      },
    },
    {
      name: "drain",
      timeoutMs: 60 * 60_000,
      async run(sim) {
        sim.state.result = await drain(sim);
        return JSON.stringify(sim.state.result);
      },
    },
  ],
  checks,
});
