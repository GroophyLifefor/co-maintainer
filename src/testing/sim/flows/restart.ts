/** `serve` dies while a review job waits, and starts again.
 *
 * A killed process runs no catch and no finally: the job row stays
 * `running`, the check run stays `in_progress`, and the review row keeps the
 * status it had. On the next start `serve` reconciles each such job before
 * it listens. The flow freezes a job on a GitHub call that never answers
 * (`hang`), restarts the server with the product's own startup code, and
 * reads what GitHub and app.db hold after:
 *
 * - a job still queued when the process died runs after the restart
 * - a job cut off while it read the files is reviewed again from the top
 * - a job cut off after GitHub took the review, before the answer was read,
 *   adopts that review and posts no second one
 * - a job cut off before GitHub took the review fails, says so on the check
 *   run, and can be retried
 *
 * Every check reads GitHub's reviews and check runs, the job and review rows,
 * never what the model answered, so the flow passes with a real model too. */
import type { AiRule } from "../fake_ai.ts";
import { check, type CheckResult, defineFlow, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, OPENED_MATH, appRows, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides",
  queued: "the process dies with a review still queued",
  drafting: "the process dies while the review reads the files",
  landed: "the process dies after GitHub took the review",
  lost: "the process dies before GitHub took the review",
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

const FILES = /\/pulls\/\d+\/files$/;
const REVIEWS = /\/pulls\/\d+\/reviews$/;

function open(sim: Sim, key: string, title: string): SimPull {
  const pull = sim.github.openPull(APP_REPO, {
    title,
    files: { "src/math.ts": OPENED_MATH },
  });
  sim.state[key] = pull;
  return pull;
}

async function deliver(sim: Sim, pull: SimPull): Promise<void> {
  await sim.server.deliver(
    "pull_request",
    sim.server.payloads.pullRequest(pull, "opened"),
  );
}

/** Restarts the server, runs the queue, and says what came back. */
async function restartAndRun(sim: Sim): Promise<string> {
  const restart = await sim.server.restart();
  const jobs = [...restart.finished, ...(await sim.server.runJobs())];
  return `restart recovered ${restart.orphans} · ${jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job"}`;
}

/** The step's crash: the job freezes on the planned `hang`. */
async function crashOn(
  sim: Sim,
  key: string,
  title: string,
  hang: { method: string; path: RegExp; landed?: boolean },
): Promise<string> {
  sim.faults.add({ target: "github", kind: "hang", ...hang });
  const pull = open(sim, key, title);
  await deliver(sim, pull);
  const crashed = await sim.server.crashDuringJob(sim.faults);
  return `#${pull.number} · ${crashed} · ${await restartAndRun(sim)}`;
}

const pullAt = (sim: Sim, key: string) => sim.state[key] as SimPull;

function botReviews(sim: Sim, pull: SimPull) {
  return sim.github.reviews.filter(
    (review) =>
      review.repo === pull.repo &&
      review.number === pull.number &&
      review.user.type === "Bot",
  );
}

function checkRuns(sim: Sim, pull: SimPull) {
  return sim.github.checkRuns.filter((run) => run.headSha === pull.headSha);
}

type Row = {
  job_status: string;
  cancel_reason: string | null;
  error: string | null;
  review_status: string | null;
  posted_review_id: string | null;
};

function rowsOf(sim: Sim, pull: SimPull): Row[] {
  return appRows<Row>(
    sim,
    `SELECT jobs.status AS job_status, jobs.cancel_reason, jobs.error, reviews.status AS review_status, reviews.posted_review_id
       FROM jobs LEFT JOIN reviews ON reviews.job_id = jobs.id
      WHERE jobs.type = 'review' AND jobs.repo = ? AND jobs.pr_number = ?`,
    APP_REPO,
    pull.number,
  );
}

function state(sim: Sim, pull: SimPull): string {
  const runs = checkRuns(sim, pull)
    .map((run) => `${run.status} ${run.conclusion ?? ""}`.trim())
    .join(", ");
  const rows = rowsOf(sim, pull)
    .map(
      (row) => `job ${row.job_status}, review ${row.review_status ?? "none"}`,
    )
    .join(" | ");
  return `${botReviews(sim, pull).length} bot reviews · checks ${runs || "none"} · ${rows || "no rows"}`;
}

function allCompleted(sim: Sim, pull: SimPull): boolean {
  const runs = checkRuns(sim, pull);
  return runs.length > 0 && runs.every((run) => run.status === "completed");
}

function checks(sim: Sim): CheckResult[] {
  const queued = pullAt(sim, "queued");
  const drafting = pullAt(sim, "drafting");
  const landed = pullAt(sim, "landed");
  const lost = pullAt(sim, "lost");
  const landedRow = rowsOf(sim, landed)[0];
  const lostRow = rowsOf(sim, lost)[0];
  const landedReview = botReviews(sim, landed)[0];
  const running = appRows<{ n: number }>(
    sim,
    `SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'`,
  )[0]!.n;
  return [
    check(
      "a review still queued when the process died runs after the restart: one review, the check completed",
      botReviews(sim, queued).length === 1 &&
        allCompleted(sim, queued) &&
        rowsOf(sim, queued).every((row) => row.job_status === "done"),
      state(sim, queued),
    ),
    check(
      "a review cut off while it read the files is reviewed again: one review, every check run completed",
      botReviews(sim, drafting).length === 1 &&
        allCompleted(sim, drafting) &&
        rowsOf(sim, drafting).every((row) => row.job_status === "done"),
      state(sim, drafting),
    ),
    check(
      "a review GitHub took before the crash is adopted: no second review, the row holds its id",
      botReviews(sim, landed).length === 1 &&
        landedRow?.review_status === "posted" &&
        landedRow.posted_review_id === String(landedReview?.id ?? ""),
      `${state(sim, landed)} · posted id ${landedRow?.posted_review_id ?? "none"}`,
    ),
    check(
      "a review GitHub took before the crash completes its check run",
      allCompleted(sim, landed),
      state(sim, landed),
    ),
    check(
      "a review GitHub never got fails: nothing posted, the job is failed so it can be retried, and the check run says so",
      botReviews(sim, lost).length === 0 &&
        lostRow?.job_status === "failed" &&
        allCompleted(sim, lost) &&
        checkRuns(sim, lost).every((run) => run.conclusion === "failure"),
      `${state(sim, lost)} · error ${lostRow?.error ?? "none"}`,
    ),
    check(
      "no job is left running after the restart",
      running === 0,
      `${running} running`,
    ),
  ];
}

export default defineFlow({
  name: "restart",
  description:
    "serve dies while a review job waits and starts again: queued, drafting and posting jobs end with one review and a completed check",
  ai: AI,
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await serveRepo(sim);
        return `${APP_REPO} · guides built · auto review on`;
      },
    },
    {
      name: STEP.queued,
      async run(sim) {
        const pull = open(sim, "queued", "Add divide and average");
        await deliver(sim, pull);
        return `#${pull.number} · queued · ${await restartAndRun(sim)}`;
      },
    },
    {
      name: STEP.drafting,
      run: (sim) =>
        crashOn(sim, "drafting", "Add divide and average again", {
          method: "GET",
          path: FILES,
        }),
    },
    {
      name: STEP.landed,
      run: (sim) =>
        crashOn(sim, "landed", "Add divide and average a third time", {
          method: "POST",
          path: REVIEWS,
          landed: true,
        }),
    },
    {
      name: STEP.lost,
      run: (sim) =>
        crashOn(sim, "lost", "Add divide and average a fourth time", {
          method: "POST",
          path: REVIEWS,
        }),
    },
  ],
  checks,
});
