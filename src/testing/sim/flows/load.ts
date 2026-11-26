/** A small load run for the load test design: many pull requests arrive at
 * once, the product's own worker loop runs them with its own concurrency, and
 * the flow reports how long they took. It runs only when named:
 * `--flow=load`, with `LOAD_PRS` pull requests (default 20, the design run uses 100), `LOAD_AI_MS`
 * of model latency per review (default 200 ms) and `LOAD_JOBS` concurrent
 * jobs (default the product's own). The fake AI costs nothing.
 * It asserts that every pull request got exactly one review and no job
 * failed, and reports the numbers in the check's detail. */
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import { APP_REPO, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const PRS = Number(process.env.LOAD_PRS ?? 20);
const AI_MS = Number(process.env.LOAD_AI_MS ?? 200);
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
};

async function drain(sim: Sim): Promise<Result> {
  const { startWorkerLoop, stopWorkerLoop } =
    await import("../../../services/jobs.ts");
  const { listJobs } = await import("../../../store/jobs.ts");
  const { readConfig } = await import("../../../config.ts");
  const startedAt = performance.now();
  let peakQueued = 0;
  startWorkerLoop(25);
  for (;;) {
    const queued = listJobs({ status: "queued" }).length;
    const running = listJobs({ status: "running" }).length;
    peakQueued = Math.max(peakQueued, queued);
    if (queued === 0 && running === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
  };
}

function checks(sim: Sim): CheckResult[] {
  const r = sim.state.result as Result;
  const perHour = Math.round((r.reviews / r.wallMs) * 3_600_000);
  return [
    check(
      `${PRS} pull requests: each gets one review and no job fails`,
      r.reviews === PRS && r.failed === 0,
      `${r.reviews} reviews · ${r.failed} failed · ${r.wallMs} ms wall · ${perHour} reviews/hour at ${AI_MS} ms of model time · ${r.githubCalls} GitHub calls (${(r.githubCalls / PRS).toFixed(1)} per pull request) · peak queue ${r.peakQueued} · concurrent jobs ${r.jobsLimit}`,
    ),
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
      async run(sim) {
        sim.state.result = await drain(sim);
        return JSON.stringify(sim.state.result);
      },
    },
  ],
  checks,
});
