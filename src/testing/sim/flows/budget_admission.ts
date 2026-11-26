/** A review starts only when its installation has the GitHub requests left
 * for it (0.7.33).
 *
 * The installation has 70 requests an hour and eight pull requests arrive
 * together. Reviews start while what is left covers one more and the reserve,
 * then the rest stay queued: none fails, none stops halfway, and GitHub never
 * answers with a limit. When the hour resets they run.
 *
 * Every check reads GitHub's reviews and calls and app.db rows, never what
 * the model said, so the flow passes with a real model too. */
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, appRows, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const PULLS = 8;
const LIMIT = 70;

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

const count = (sim: Sim, status: string) =>
  appRows<{ n: number }>(
    sim,
    `SELECT COUNT(*) AS n FROM jobs WHERE repo = ? AND type = 'review' AND status = ?`,
    APP_REPO,
    status,
  )[0]!.n;

function checks(sim: Sim): CheckResult[] {
  const pulls = sim.state.pulls as SimPull[];
  const first = sim.state.first as {
    done: number;
    queued: number;
    failed: number;
  };
  const reviewsAfter = pulls.map((pull) => botReviews(sim, pull));
  return [
    check(
      "with 70 requests left, some reviews start and the rest stay queued: not all, not none",
      first.done > 0 && first.queued > 0 && first.done + first.queued === PULLS,
      `${first.done} done · ${first.queued} queued`,
    ),
    check(
      "nothing fails or meets a GitHub rate limit while the budget is low",
      first.failed === 0 &&
        !sim.trace.github.some((call) => call.fault !== undefined),
      `${first.failed} failed jobs`,
    ),
    check(
      "after the reset the queued reviews run, and every pull request has exactly one review",
      reviewsAfter.every((n) => n === 1) && count(sim, "queued") === 0,
      `reviews per pull request: ${reviewsAfter.join(", ")}`,
    ),
  ];
}

export default defineFlow({
  name: "budget-admission",
  description:
    "a review starts only when its installation has the requests left, the rest stay queued without failing, and run after the reset",
  ai: AI,
  steps: [
    {
      name: "serve a repository whose installation has 70 requests an hour",
      async run(sim) {
        await serveRepo(sim);
        sim.state.pulls = [];
        sim.github.budget = {
          limit: LIMIT,
          remaining: LIMIT,
          resetAt: Math.floor(Date.now() / 1000) + 3600,
        };
        return `${APP_REPO} · ${LIMIT} requests`;
      },
    },
    {
      name: `${PULLS} pull requests arrive together, the budget runs low`,
      async run(sim) {
        for (let i = 0; i < PULLS; i++) {
          const pull = sim.github.openPull(APP_REPO, {
            title: `Add note ${i}`,
            files: { [`docs/b${i}.md`]: `# ${i}\n` },
          });
          (sim.state.pulls as SimPull[]).push(pull);
          await sim.server.deliver(
            "pull_request",
            sim.server.payloads.pullRequest(pull, "opened"),
            { deliveryId: `budget-${i}` },
          );
        }
        await sim.server.runJobs();
        sim.state.first = {
          done: count(sim, "done"),
          queued: count(sim, "queued"),
          failed: count(sim, "failed"),
        };
        return `${count(sim, "done")} done · ${count(sim, "queued")} queued`;
      },
    },
    {
      name: "the hour resets",
      async run(sim) {
        sim.github.budget = {
          limit: LIMIT,
          remaining: LIMIT,
          resetAt: Math.floor(Date.now() / 1000) + 3600,
        };
        // The reset is a new hour: what the product remembers has passed.
        const { resetBudgetsForTest } =
          await import("../../../github/budget.ts");
        resetBudgetsForTest();
        const jobs = await sim.server.runJobs();
        return `${jobs.length} jobs ran`;
      },
    },
  ],
  checks,
});
