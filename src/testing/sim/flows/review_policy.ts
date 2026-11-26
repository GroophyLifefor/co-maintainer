/** The review policy engine, end to end through `serve`: who gets an
 * automatic review.
 *
 * The repository takes the `trusted-auto` template. A pull request from the
 * owner is reviewed. A draft and a bot's are skipped. A first-time
 * contributor's waits: it is reviewed only after someone trusted comments
 * `/co-maintainer review`, and a stranger's request changes nothing.
 *
 * Every check reads GitHub's reviews and writes and app.db rows, never what
 * the model answered, so the flow passes with a real model too. */
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, OPENED_MATH, deliverOpened, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with the trusted-auto policy",
  owner: "a pull request from the owner",
  draft: "a draft pull request",
  bot: "a pull request from a bot",
  stranger: "a pull request from a first-time contributor",
  asked: "a stranger asks for a review",
  trusted: "the owner asks for a review",
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

const pullOf = (sim: Sim, key: string) => sim.state[key] as SimPull;

function reviewsOf(sim: Sim, pull: SimPull): number {
  return sim.github.reviews.filter(
    (review) =>
      review.repo === pull.repo &&
      review.number === pull.number &&
      review.user.type === "Bot",
  ).length;
}

async function open(
  sim: Sim,
  key: string,
  input: Parameters<Sim["github"]["openPull"]>[1],
): Promise<string> {
  const pull = sim.github.openPull(APP_REPO, input);
  sim.state[key] = pull;
  const round = await deliverOpened(sim, pull);
  return `${String(round.delivery.body.outcome)} · ${round.jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job"} · ${reviewsOf(sim, pull)} reviews`;
}

async function say(
  sim: Sim,
  key: string,
  body: string,
  association: string,
): Promise<string> {
  const pull = pullOf(sim, key);
  const comment = sim.github.comment(pull, body, "sim-commenter", association);
  const delivery = await sim.server.deliver(
    "issue_comment",
    sim.server.payloads.issueComment(pull, comment),
  );
  const jobs = await sim.server.runJobs();
  return `${String(delivery.body.outcome)} · ${jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job"} · ${reviewsOf(sim, pull)} reviews`;
}

function checks(sim: Sim): CheckResult[] {
  const owner = pullOf(sim, "owner");
  const draft = pullOf(sim, "draft");
  const bot = pullOf(sim, "bot");
  const stranger = pullOf(sim, "stranger");
  const counts = sim.state.strangerCounts as number[];
  return [
    check(
      "a pull request from the owner is reviewed once",
      reviewsOf(sim, owner) === 1,
      `${reviewsOf(sim, owner)} reviews`,
    ),
    check(
      "a draft is not reviewed",
      reviewsOf(sim, draft) === 0,
      `${reviewsOf(sim, draft)} reviews`,
    ),
    check(
      "a pull request from a bot is not reviewed",
      reviewsOf(sim, bot) === 0,
      `${reviewsOf(sim, bot)} reviews`,
    ),
    check(
      "a first-time contributor's pull request waits: no review when opened, none after a stranger asks",
      counts[0] === 0 && counts[1] === 0,
      `opened ${counts[0]} · after the stranger ${counts[1]}`,
    ),
    check(
      "the owner's request gets the first-time contributor a review",
      reviewsOf(sim, stranger) === 1,
      `${reviewsOf(sim, stranger)} reviews`,
    ),
  ];
}

export default defineFlow({
  name: "review-policy",
  description:
    "the trusted-auto policy: the owner's pull request is reviewed, a draft and a bot's are skipped, a first-time contributor's waits for a trusted request",
  ai: AI,
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await serveRepo(sim);
        const { updateRepoSettings } = await import("../../../store/repos.ts");
        updateRepoSettings(APP_REPO, {
          review_policy_json: JSON.stringify("trusted-auto"),
        });
        return `${APP_REPO} · trusted-auto`;
      },
    },
    {
      name: STEP.owner,
      run: (sim) =>
        open(sim, "owner", {
          title: "Add divide and average",
          files: { "src/math.ts": OPENED_MATH },
          association: "OWNER",
        }),
    },
    {
      name: STEP.draft,
      run: (sim) =>
        open(sim, "draft", {
          title: "Draft change",
          files: { "docs/draft.md": "# Draft\n" },
          draft: true,
          association: "OWNER",
        }),
    },
    {
      name: STEP.bot,
      run: (sim) =>
        open(sim, "bot", {
          title: "Bump a dependency",
          files: { "docs/bump.md": "# Bump\n" },
          author: "dependabot[bot]",
          authorType: "Bot",
          association: "NONE",
        }),
    },
    {
      name: STEP.stranger,
      async run(sim) {
        const detail = await open(sim, "stranger", {
          title: "A fix from a newcomer",
          files: { "docs/fix.md": "# Fix\n" },
          author: "newcomer",
          association: "FIRST_TIME_CONTRIBUTOR",
        });
        sim.state.strangerCounts = [reviewsOf(sim, pullOf(sim, "stranger"))];
        return detail;
      },
    },
    {
      name: STEP.asked,
      async run(sim) {
        const detail = await say(
          sim,
          "stranger",
          "/co-maintainer review",
          "FIRST_TIME_CONTRIBUTOR",
        );
        (sim.state.strangerCounts as number[]).push(
          reviewsOf(sim, pullOf(sim, "stranger")),
        );
        return detail;
      },
    },
    {
      name: STEP.trusted,
      run: (sim) => say(sim, "stranger", "/co-maintainer review", "OWNER"),
    },
  ],
  checks,
});
