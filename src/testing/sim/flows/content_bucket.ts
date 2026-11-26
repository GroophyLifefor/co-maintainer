/** GitHub's content write limit (0.7.33): an installation may post 80 reviews
 * or comments a minute and 500 an hour. The product spaces its own writes.
 *
 * The allowance is set to 2 an hour and three pull requests arrive together.
 * The first two reviews post at once. The third waits for their
 * place: each wait is on the job's log, and every review still posts. A check
 * run is not a content write, so it never waits.
 *
 * Every check reads GitHub's reviews, check runs and the jobs' logs, never
 * what the model said, so the flow passes with a real model too. */
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, appRows, deliverOpened, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const ALLOWANCE = 2;
const PULLS = 3;

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "any review",
    job: "review_pull_request",
    prompt: /[\s\S]*/,
    reply: { findings: [] },
  },
];

const botReviews = (sim: Sim, pull: SimPull) =>
  sim.github.reviews.filter(
    (review) =>
      review.repo === pull.repo &&
      review.number === pull.number &&
      review.user.type === "Bot",
  ).length;

function waits(sim: Sim): number[] {
  return appRows<{ message: string }>(
    sim,
    `SELECT message FROM job_logs WHERE message LIKE '%rate_limit_wait%' AND message LIKE '%content write%' ORDER BY rowid`,
  ).map((row) =>
    Number((JSON.parse(row.message) as { seconds: number }).seconds),
  );
}

function checks(sim: Sim): CheckResult[] {
  const pulls = sim.state.pulls as SimPull[];
  const waited = waits(sim);
  const reviews = pulls.map((pull) => botReviews(sim, pull));
  return [
    check(
      `all ${PULLS} reviews post, none is lost to the limit`,
      reviews.every((n) => n === 1),
      `reviews per pull request: ${reviews.join(", ")}`,
    ),
    check(
      `with ${ALLOWANCE} writes an hour, the first ${ALLOWANCE} post at once and the other ${PULLS - ALLOWANCE} wait about an hour for their place`,
      waited.length === PULLS - ALLOWANCE &&
        waited.every((seconds) => seconds > 3_000 && seconds <= 3_600),
      `waits ${waited.join(", ") || "none"} s`,
    ),
    check(
      "check runs are not content writes: every check run completed without a content wait",
      sim.github.checkRuns.length === PULLS &&
        sim.github.checkRuns.every((run) => run.status === "completed"),
      `${sim.github.checkRuns.length} check runs`,
    ),
  ];
}

export default defineFlow({
  name: "content-bucket",
  description:
    "an installation posts at most its hourly allowance of reviews and comments, later ones wait for their place, none is lost, check runs never wait",
  ai: AI,
  steps: [
    {
      name: "serve a repository with an allowance of 2 writes an hour",
      async run(sim) {
        await serveRepo(sim);
        sim.world.writeConfig({ contentWritesPerHour: ALLOWANCE });
        sim.state.pulls = [];
        return `${APP_REPO} · allowance ${ALLOWANCE}`;
      },
    },
    {
      name: `${PULLS} pull requests arrive together`,
      async run(sim) {
        const details: string[] = [];
        for (let i = 0; i < PULLS; i++) {
          const pull = sim.github.openPull(APP_REPO, {
            title: `Add note ${i}`,
            files: { [`docs/c${i}.md`]: `# ${i}\n` },
          });
          (sim.state.pulls as SimPull[]).push(pull);
          const round = await deliverOpened(sim, pull);
          details.push(
            round.jobs.map((job) => `${job.type} ${job.status}`).join(", "),
          );
        }
        return details.join(" | ");
      },
    },
  ],
  checks,
});
