/** Retry and Dismiss on the failed rows of the Activity list, end to end
 * through `serve` and the dashboard's own routes.
 *
 * A review fails because the model's service does. Retry starts a new review
 * of the same pull request and it posts. A row asked for twice, once as the
 * job and once as its review, starts one review. A row that did not fail has
 * nothing to retry. Dismiss marks a failure as seen, and only once.
 *
 * Every check reads GitHub's reviews, app.db rows and what the routes
 * answered, never what the model said, so the flow passes with a real model
 * too. */
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, appRows, deliverOpened, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides",
  failed: "a review that fails",
  retried: "Retry on the failed row",
  twice: "Retry on the job and the review of one failure",
  notFailed: "Retry on a row that did not fail",
  second: "a second review that fails",
  dismissed: "Dismiss on the failed row, twice",
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

type Job = { id: string; type: string; status: string; pr_number: number };

const failedJobs = (sim: Sim, pr: number): Job[] =>
  appRows<Job>(
    sim,
    `SELECT id, type, status, pr_number FROM jobs WHERE repo = ? AND pr_number = ? AND status = 'failed'`,
    APP_REPO,
    pr,
  );

async function activity(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { handleActivityRoute } =
    await import("../../../server/api/activity.ts");
  const url = new URL(`http://localhost${path}`);
  const response = await handleActivityRoute(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "fetch",
      },
      body: JSON.stringify(body),
    }),
    url,
  );
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

async function failOnce(sim: Sim, key: string, title: string): Promise<string> {
  sim.faults.add({ target: "ai", kind: "500", job: "review_pull_request" });
  const pull = sim.github.openPull(APP_REPO, {
    title,
    files: { [`docs/${key}.md`]: `# ${title}\n` },
  });
  sim.state[key] = pull;
  const round = await deliverOpened(sim, pull);
  return round.jobs.map((job) => `${job.type} ${job.status}`).join(", ");
}

const pullOf = (sim: Sim, key: string) => sim.state[key] as SimPull;

const botReviews = (sim: Sim, pull: SimPull) =>
  sim.github.reviews.filter(
    (review) =>
      review.repo === pull.repo &&
      review.number === pull.number &&
      review.user.type === "Bot",
  ).length;

function checks(sim: Sim): CheckResult[] {
  const retried = sim.state.retried as {
    jobIds: string[];
    reviews: number;
  };
  const twice = sim.state.twice as { jobIds: string[]; skipped: number };
  const notFailed = sim.state.notFailed as {
    jobIds: string[];
    skipped: number;
  };
  const dismiss = sim.state.dismiss as number[];
  return [
    check(
      "Retry on a failed review starts one review job, and it posts a review",
      retried.jobIds.length === 1 && retried.reviews === 1,
      `${retried.jobIds.length} jobs · ${retried.reviews} reviews`,
    ),
    check(
      "the job and the review of one failure start one review, not two",
      twice.jobIds.length === 1 && twice.skipped === 1,
      `${twice.jobIds.length} jobs · ${twice.skipped} skipped`,
    ),
    check(
      "a row that did not fail has nothing to retry",
      notFailed.jobIds.length === 0 && notFailed.skipped === 1,
      `${notFailed.jobIds.length} jobs · ${notFailed.skipped} skipped`,
    ),
    check(
      "Dismiss marks the failure as seen: something the first time, nothing the second",
      Number(dismiss[0]) > 0 && dismiss[1] === 0,
      `first ${dismiss[0]} · second ${dismiss[1]}`,
    ),
  ];
}

export default defineFlow({
  name: "activity-actions",
  description:
    "Retry starts one new review for a failed row, a row that did not fail has nothing to retry, Dismiss marks a failure as seen once",
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
      name: STEP.failed,
      async run(sim) {
        const detail = await failOnce(sim, "first", "Add divide and average");
        const pull = pullOf(sim, "first");
        sim.state.firstFailed = failedJobs(sim, pull.number)[0]?.id;
        return detail;
      },
    },
    {
      name: STEP.retried,
      async run(sim) {
        const res = await activity("/api/activity/retry", {
          keys: [`job:${String(sim.state.firstFailed)}`],
        });
        const jobs = await sim.server.runJobs();
        sim.state.retried = {
          ...res.json,
          reviews: botReviews(sim, pullOf(sim, "first")),
        };
        return `${res.status} · ${jobs.map((job) => `${job.type} ${job.status}`).join(", ")}`;
      },
    },
    {
      name: STEP.twice,
      async run(sim) {
        const id = String(sim.state.firstFailed);
        const review = appRows<{ id: string }>(
          sim,
          `SELECT id FROM reviews WHERE job_id = ?`,
          id,
        )[0]?.id;
        const res = await activity("/api/activity/retry", {
          keys: [`job:${id}`, `review:${String(review)}`],
        });
        sim.state.twice = res.json;
        const jobs = await sim.server.runJobs();
        return `${res.status} · ${jobs.length} jobs`;
      },
    },
    {
      name: STEP.notFailed,
      async run(sim) {
        const done = appRows<{ id: string }>(
          sim,
          `SELECT id FROM jobs WHERE repo = ? AND status = 'done' AND type = 'review' LIMIT 1`,
          APP_REPO,
        )[0]?.id;
        const res = await activity("/api/activity/retry", {
          keys: [`job:${String(done)}`],
        });
        sim.state.notFailed = res.json;
        const jobs = await sim.server.runJobs();
        return `${res.status} · ${jobs.length} jobs`;
      },
    },
    {
      name: STEP.second,
      async run(sim) {
        const detail = await failOnce(sim, "second", "Add a note");
        const pull = pullOf(sim, "second");
        sim.state.secondFailed = failedJobs(sim, pull.number)[0]?.id;
        return detail;
      },
    },
    {
      name: STEP.dismissed,
      async run(sim) {
        const key = `job:${String(sim.state.secondFailed)}`;
        const one = await activity("/api/activity/dismiss", { keys: [key] });
        const again = await activity("/api/activity/dismiss", { keys: [key] });
        sim.state.dismiss = [one.json.dismissed, again.json.dismissed];
        return `${String(one.json.dismissed)} then ${String(again.json.dismissed)}`;
      },
    },
  ],
  checks,
});
