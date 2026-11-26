/** A review that posts fine while GitHub refuses its check run: the job
 * finishes, and the Activity list marks it with a warning that says what is
 * wrong.
 *
 * GitHub answers 403 to every check run call, the way it does when the App
 * lacks the Checks permission. The review still posts, the job is done, and
 * the job's warning names the permission. A review with no refusal has no
 * warning.
 *
 * Every check reads GitHub's reviews, app.db rows and the warning the product
 * built from the job's log, never what the model said, so the flow passes
 * with a real model too. */
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, appRows, deliverOpened, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides",
  refused: "a review while GitHub refuses the check run",
  fine: "a review with no refusal",
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

const botReviews = (sim: Sim, pull: SimPull) =>
  sim.github.reviews.filter(
    (review) =>
      review.repo === pull.repo &&
      review.number === pull.number &&
      review.user.type === "Bot",
  ).length;

async function warningFor(
  sim: Sim,
  pull: SimPull,
): Promise<{ status: string; problem: string | undefined }> {
  const job = appRows<{ id: string; status: string }>(
    sim,
    `SELECT id, status FROM jobs WHERE repo = ? AND pr_number = ? AND type = 'review' ORDER BY rowid DESC LIMIT 1`,
    APP_REPO,
    pull.number,
  )[0];
  const { warningsForJobs } = await import("../../../services/job_warnings.ts");
  const warning = job ? warningsForJobs([job.id]).get(job.id) : undefined;
  return { status: job?.status ?? "no job", problem: warning?.problem };
}

async function open(sim: Sim, key: string, title: string): Promise<string> {
  const pull = sim.github.openPull(APP_REPO, {
    title,
    files: { [`docs/${key}.md`]: `# ${title}\n` },
  });
  sim.state[key] = pull;
  const round = await deliverOpened(sim, pull);
  sim.state[`${key}Warning`] = await warningFor(sim, pull);
  return `${round.jobs.map((job) => `${job.type} ${job.status}`).join(", ")} · ${botReviews(sim, pull)} reviews`;
}

function checks(sim: Sim): CheckResult[] {
  const refused = sim.state.refused as SimPull;
  const fine = sim.state.fine as SimPull;
  const refusedWarning = sim.state.refusedWarning as {
    status: string;
    problem: string | undefined;
  };
  const fineWarning = sim.state.fineWarning as {
    status: string;
    problem: string | undefined;
  };
  return [
    check(
      "the review posts and the job is done although GitHub refused the check run",
      botReviews(sim, refused) === 1 && refusedWarning.status === "done",
      `${botReviews(sim, refused)} reviews · job ${refusedWarning.status}`,
    ),
    check(
      "the job carries a warning that names the Checks permission",
      /Checks permission/.test(refusedWarning.problem ?? ""),
      refusedWarning.problem ?? "no warning",
    ),
    check(
      "a review with no refusal has no warning",
      botReviews(sim, fine) === 1 && fineWarning.problem === undefined,
      `${botReviews(sim, fine)} reviews · ${fineWarning.problem ?? "no warning"}`,
    ),
  ];
}

export default defineFlow({
  name: "job-warnings",
  description:
    "a review posts while GitHub refuses its check run: the job is done and carries a warning naming the Checks permission, a normal review has none",
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
      name: STEP.refused,
      async run(sim) {
        sim.faults.add({
          target: "github",
          kind: 403,
          path: "/check-runs",
          times: 1,
        });
        return open(sim, "refused", "Add a refused note");
      },
    },
    {
      name: STEP.fine,
      run: (sim) => open(sim, "fine", "Add a fine note"),
    },
  ],
  checks,
});
