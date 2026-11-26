/** A review that waited too long in the queue is skipped (0.7.32).
 *
 * The flow queues a review, makes its job older than the limit and lets the
 * product run it. The job is canceled with its reason, the pull request gets
 * one note, and no review or check run is written. A second old job for the
 * same pull request adds no second note. Retry from the Activity routes
 * starts a fresh job that reviews. The limit follows the setting.
 *
 * Every check reads GitHub's reviews, comments and check runs and app.db
 * rows, never what the model said, so the flow passes with a real model too. */
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, appRows, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides",
  old: "a queued review older than the limit",
  again: "a second old job for the same pull request",
  retried: "Retry on the skipped job",
  setting: "a shorter limit in the settings",
  noteFails: "an old job whose note cannot be posted",
  noteAgain: "the next old job for that pull request",
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

const HOURS = 3_600_000;
const NOTE = "co-maintainer:queued-too-long";

const pullOf = (sim: Sim) => sim.state.pull as SimPull;

const botReviews = (sim: Sim) =>
  sim.github.reviews.filter(
    (review) =>
      review.repo === pullOf(sim).repo &&
      review.number === pullOf(sim).number &&
      review.user.type === "Bot",
  ).length;

const notes = (sim: Sim, pull: SimPull = pullOf(sim)) =>
  sim.github.comments.filter(
    (comment) => comment.number === pull.number && comment.body.includes(NOTE),
  ).length;

type JobRow = { id: string; status: string; cancel_reason: string | null };

const jobsOf = (sim: Sim, pull: SimPull = pullOf(sim)) =>
  appRows<JobRow>(
    sim,
    `SELECT id, status, cancel_reason FROM jobs WHERE repo = ? AND pr_number = ? AND type = 'review' ORDER BY rowid`,
    APP_REPO,
    pull.number,
  );

const lastJob = (sim: Sim, pull: SimPull) => jobsOf(sim, pull).at(-1);

/** Delivers a push and makes the queued job `hours` old, then runs it. */
async function queueOld(
  sim: Sim,
  hours: number,
  files: Record<string, string>,
  deliveryId: string,
  pull: SimPull = pullOf(sim),
): Promise<string> {
  sim.github.push(pull, files, "push");
  await sim.server.deliver(
    "pull_request",
    sim.server.payloads.pullRequest(pull, "synchronize"),
    { deliveryId },
  );
  const { getAppDb } = await import("../../../store/app_db.ts");
  const old = new Date(Date.now() - hours * HOURS).toISOString();
  getAppDb()
    .prepare(
      `UPDATE jobs SET created_at = ? WHERE repo = ? AND pr_number = ? AND status = 'queued'`,
    )
    .run(old, APP_REPO, pull.number);
  const jobs = await sim.server.runJobs();
  return jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job";
}

function checks(sim: Sim): CheckResult[] {
  const s = sim.state as Record<string, any>;
  return [
    check(
      "a review older than the limit is canceled as queued too long, with no review and no check run",
      s.afterOld.job?.status === "canceled" &&
        s.afterOld.job?.cancel_reason === "queued_too_long" &&
        s.afterOld.reviews === 0 &&
        s.afterOld.checks === 0,
      JSON.stringify(s.afterOld),
    ),
    check(
      "the pull request gets one note, with the hidden marker",
      s.afterOld.notes === 1,
      `${s.afterOld.notes} notes`,
    ),
    check(
      "a second old job for the same pull request adds no second note",
      s.afterAgain.notes === 1 && s.afterAgain.status === "canceled",
      `${s.afterAgain.notes} notes · ${s.afterAgain.status}`,
    ),
    check(
      "Retry on the skipped job starts one job that reviews the pull request",
      s.retried.jobIds === 1 && s.retried.reviews === 1,
      `${s.retried.jobIds} jobs · ${s.retried.reviews} reviews`,
    ),
    check(
      "a skip whose note failed does not count as a note: the next old job posts it",
      s.noteFails.reason === "queued_too_long_no_note" &&
        s.noteFails.notes === 0 &&
        s.noteAgain.reason === "queued_too_long" &&
        s.noteAgain.notes === 1,
      JSON.stringify([s.noteFails, s.noteAgain]),
    ),
    check(
      "a limit of 5 hours skips a job 6 hours old, which the default 24 hours would run",
      s.short.canceled === true && s.short.defaultRan === true,
      JSON.stringify(s.short),
    ),
  ];
}

export default defineFlow({
  name: "queue-age",
  description:
    "a review queued longer than the limit is canceled with a note on the pull request, once, Retry reviews it, the limit is a setting",
  ai: AI,
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await serveRepo(sim);
        const pull = sim.github.openPull(APP_REPO, {
          title: "Add a note",
          files: { "docs/n0.md": "# 0\n" },
        });
        sim.state.pull = pull;
        return `${APP_REPO} · guides built`;
      },
    },
    {
      name: STEP.old,
      async run(sim) {
        const detail = await queueOld(
          sim,
          25,
          { "docs/n1.md": "# 1\n" },
          "qa-1",
        );
        const jobs = jobsOf(sim);
        sim.state.afterOld = {
          job: jobs[0],
          reviews: botReviews(sim),
          checks: sim.github.checkRuns.length,
          notes: notes(sim),
        };
        return detail;
      },
    },
    {
      name: STEP.again,
      async run(sim) {
        const detail = await queueOld(
          sim,
          26,
          { "docs/n2.md": "# 2\n" },
          "qa-2",
        );
        const jobs = jobsOf(sim);
        sim.state.afterAgain = {
          notes: notes(sim),
          status: jobs[jobs.length - 1]?.status,
        };
        return detail;
      },
    },
    {
      name: STEP.retried,
      async run(sim) {
        const { handleActivityRoute } =
          await import("../../../server/api/activity.ts");
        const first = jobsOf(sim)[0]!;
        const url = new URL("http://localhost/api/activity/retry");
        const response = await handleActivityRoute(
          new Request(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-requested-with": "fetch",
            },
            body: JSON.stringify({ keys: [`job:${first.id}`] }),
          }),
          url,
        );
        const body = (await response.json()) as { jobIds: string[] };
        const jobs = await sim.server.runJobs();
        sim.state.retried = {
          jobIds: body.jobIds.length,
          reviews: botReviews(sim),
        };
        return `${response.status} · ${jobs.map((job) => `${job.type} ${job.status}`).join(", ")}`;
      },
    },
    {
      name: STEP.setting,
      async run(sim) {
        // 6 hours old with the default limit of 24: the job runs.
        const ran = await queueOld(sim, 6, { "docs/n3.md": "# 3\n" }, "qa-3");
        const defaultRan = jobsOf(sim).at(-1)?.status === "done";
        sim.world.writeConfig({ queueMaxAgeHours: 5 });
        const skipped = await queueOld(
          sim,
          6,
          { "docs/n4.md": "# 4\n" },
          "qa-4",
        );
        const canceled = jobsOf(sim).at(-1)?.status === "canceled";
        sim.state.short = { defaultRan, canceled };
        return `${ran} · ${skipped}`;
      },
    },
    {
      name: STEP.noteFails,
      async run(sim) {
        const pull2 = sim.github.openPull(APP_REPO, {
          title: "Another note",
          files: { "docs/m0.md": "# m\n" },
        });
        sim.state.pull2 = pull2;
        sim.faults.add({
          target: "github",
          kind: 500,
          method: "POST",
          path: /\/issues\/\d+\/comments$/,
        });
        const detail = await queueOld(
          sim,
          25,
          { "docs/m1.md": "# 1\n" },
          "qb-1",
          pull2,
        );
        sim.state.noteFails = {
          reason: lastJob(sim, pull2)?.cancel_reason,
          notes: notes(sim, pull2),
        };
        return detail;
      },
    },
    {
      name: STEP.noteAgain,
      async run(sim) {
        const pull2 = sim.state.pull2 as SimPull;
        const detail = await queueOld(
          sim,
          26,
          { "docs/m2.md": "# 2\n" },
          "qb-2",
          pull2,
        );
        sim.state.noteAgain = {
          reason: lastJob(sim, pull2)?.cancel_reason,
          notes: notes(sim, pull2),
        };
        return detail;
      },
    },
  ],
  checks,
});
