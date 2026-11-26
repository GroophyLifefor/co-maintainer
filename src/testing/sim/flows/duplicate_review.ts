/** One head gets one automatic review (0.7.31).
 *
 * A review can wait out a rate limit while a second job for the same head
 * queues behind it, and GitHub can deliver a push twice. The second job finds
 * the head already reviewed and posts nothing. A person's own request, a
 * comment asking for a review, still gets one on the same head.
 *
 * Every check reads GitHub's reviews, check runs and writes, never what the
 * model said, so the flow passes with a real model too. */
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import {
  APP_REPO,
  OPENED_MATH,
  deliverOpened,
  serveRepo,
  writesIn,
} from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides",
  opened: "a pull request is opened and reviewed",
  again: "the same push is delivered again",
  asked: "the owner asks for a review of the same head",
};

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "any review",
    job: "review_pull_request",
    prompt: /[\s\S]*/,
    reply: { findings: [] },
  },
];

const pullOf = (sim: Sim) => sim.state.pull as SimPull;

const botReviews = (sim: Sim) =>
  sim.github.reviews.filter(
    (review) =>
      review.repo === pullOf(sim).repo &&
      review.number === pullOf(sim).number &&
      review.user.type === "Bot",
  ).length;

function checks(sim: Sim): CheckResult[] {
  const afterOpen = sim.state.afterOpen as number;
  const afterAgain = sim.state.afterAgain as number;
  return [
    check(
      "the pull request is reviewed once",
      afterOpen === 1,
      `${afterOpen} reviews`,
    ),
    check(
      "the same head delivered again is not reviewed again, and writes no review",
      afterAgain === 1 &&
        writesIn(sim, STEP.again).every(
          (write) => !/\/pulls\/\d+\/reviews$/.test(write.path),
        ),
      `${afterAgain} reviews · ${writesIn(sim, STEP.again).length} writes`,
    ),
    check(
      "the owner's own request on the same head still gets a review",
      botReviews(sim) === 2,
      `${botReviews(sim)} reviews`,
    ),
  ];
}

export default defineFlow({
  name: "duplicate-review",
  description:
    "a head reviewed once is not reviewed again by a repeated push delivery, a person's request on it still is",
  ai: AI,
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await serveRepo(sim);
        return `${APP_REPO} · guides built`;
      },
    },
    {
      name: STEP.opened,
      async run(sim) {
        const pull = sim.github.openPull(APP_REPO, {
          title: "Add divide and average",
          files: { "src/math.ts": OPENED_MATH },
        });
        sim.state.pull = pull;
        await deliverOpened(sim, pull);
        sim.state.afterOpen = botReviews(sim);
        return `${botReviews(sim)} reviews`;
      },
    },
    {
      name: STEP.again,
      async run(sim) {
        const pull = pullOf(sim);
        await sim.server.deliver(
          "pull_request",
          sim.server.payloads.pullRequest(pull, "synchronize"),
          { deliveryId: "dup-sync" },
        );
        const jobs = await sim.server.runJobs();
        sim.state.afterAgain = botReviews(sim);
        return `${jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job"} · ${botReviews(sim)} reviews`;
      },
    },
    {
      name: STEP.asked,
      async run(sim) {
        const pull = pullOf(sim);
        const comment = sim.github.comment(
          pull,
          "/co-maintainer review",
          "sim-owner",
          "OWNER",
        );
        await sim.server.deliver(
          "issue_comment",
          sim.server.payloads.issueComment(pull, comment),
        );
        const jobs = await sim.server.runJobs();
        return `${jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job"} · ${botReviews(sim)} reviews`;
      },
    },
  ],
  checks,
});
