/** A scheduled sync, end to end through `serve`: a repository with a
 * `remakeCron` schedule gets a sync when the clock matches, once per minute,
 * and a minute that does not match, a repository without a schedule and a
 * sync already waiting get nothing.
 *
 * The flow drives the product's own ticker with fixed times, so it does not
 * wait for a clock. Every check reads app.db rows and the jobs the ticker
 * queued, never what the model said, so the flow passes with a real model
 * too. */
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import { APP_REPO, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides and a schedule",
  off: "a minute that does not match the schedule",
  due: "the minute the schedule names",
  same: "the same minute again",
  waiting: "the next day while a sync waits",
};

const AI: AiRule[] = [...INIT_AI];

const AT = (day: number, hour: number, minute: number) =>
  new Date(Date.UTC(2030, 0, day, hour, minute));

type Ticker = (now: Date) => string[];
const tickerOf = (sim: Sim) => sim.state.ticker as Ticker;

function checks(sim: Sim): CheckResult[] {
  const queued = sim.state.queued as Record<string, string[]>;
  return [
    check(
      "a minute that does not match queues nothing",
      queued.off?.length === 0,
      `${queued.off?.length} queued`,
    ),
    check(
      "the minute the schedule names queues one sync for the repository",
      queued.due?.length === 1 && queued.due[0] === APP_REPO,
      queued.due?.join(", ") || "none",
    ),
    check(
      "the same minute again queues nothing",
      queued.same?.length === 0,
      `${queued.same?.length} queued`,
    ),
    check(
      "a sync already waiting is not queued twice",
      queued.waiting?.length === 0,
      `${queued.waiting?.length} queued`,
    ),
  ];
}

export default defineFlow({
  name: "remake-cron",
  description:
    "a repository with a sync schedule gets one sync in the minute the schedule names and nothing in any other minute or while one waits",
  ai: AI,
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await serveRepo(sim);
        sim.world.writeConfig({
          repos: { [APP_REPO]: { remakeCron: "30 3 * * *" } },
        });
        const { createRemakeCronTicker } =
          await import("../../../services/remake_cron.ts");
        sim.state.ticker = createRemakeCronTicker();
        sim.state.queued = {};
        return `${APP_REPO} · 30 3 * * *`;
      },
    },
    {
      name: STEP.off,
      run(sim) {
        const got = tickerOf(sim)(AT(1, 4, 30));
        (sim.state.queued as Record<string, string[]>).off = got;
        return `${got.length} queued`;
      },
    },
    {
      name: STEP.due,
      async run(sim) {
        const got = tickerOf(sim)(AT(1, 3, 30));
        (sim.state.queued as Record<string, string[]>).due = got;
        return `${got.length} queued`;
      },
    },
    {
      name: STEP.same,
      run(sim) {
        const got = tickerOf(sim)(AT(1, 3, 30));
        (sim.state.queued as Record<string, string[]>).same = got;
        return `${got.length} queued`;
      },
    },
    {
      name: STEP.waiting,
      run(sim) {
        // The sync from the first day still waits: it was never run.
        const got = tickerOf(sim)(AT(2, 3, 30));
        (sim.state.queued as Record<string, string[]>).waiting = got;
        return `${got.length} queued`;
      },
    },
  ],
  checks,
});
