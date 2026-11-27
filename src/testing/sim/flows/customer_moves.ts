/** What a customer does to their own server, and what must survive it.
 *
 * Moving the data to another machine, restoring last night's backup and
 * losing the disk are all things a customer will do, so each is tried here
 * before one does. The data folder holds app.db (jobs, reviews, delivery
 * ids) and config.json, and GitHub holds every review that was posted. After
 * each one the server starts again and reviews carry on: a pull request that
 * was reviewed before is not reviewed a second time, whatever app.db
 * remembers, and a new one is reviewed once.
 *
 * Every check reads GitHub's reviews and app.db rows, never what the model
 * answered, so the flow passes with a real model too. */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, OPENED_MATH, openPull, deliverOpened } from "./app.ts";
import { INIT_AI } from "./init.ts";
import { serveRepo } from "./app.ts";

const STEP = {
  served: "serve a repository with guides",
  reviewed: "a pull request is reviewed",
  moved: "the data is copied to another place and the server starts from it",
  afterMove: "a new pull request, and the first one delivered again",
  backedUp: "a backup is taken, then another pull request is reviewed",
  restored: "the backup is put back and the server starts",
  afterRestore: "the pull request reviewed after the backup is delivered again",
  lost: "app.db is lost: it is gone, the server starts and finds the guides on disk",
  afterLoss:
    "a new pull request is skipped with automatic review off, then reviewed once it is switched on, with no guides built",
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

const FILES = { "src/math.ts": OPENED_MATH };
const pullOf = (sim: Sim, key: string) => sim.state[key] as SimPull;

function botReviews(sim: Sim, pull: SimPull): number {
  return sim.github.reviews.filter(
    (review) =>
      review.repo === pull.repo &&
      review.number === pull.number &&
      review.user.type === "Bot",
  ).length;
}

/** The database the server is using now: its place changes in a move. */
const dbPath = () => process.env.CM_APP_DB as string;

function rows<T>(sql: string, ...params: (string | number)[]): T[] {
  const database = new DatabaseSync(dbPath(), { readOnly: true });
  try {
    return database.prepare(sql).all(...params) as T[];
  } finally {
    database.close();
  }
}

const sidecars = ["", "-wal", "-shm"];

function copyDb(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  for (const suffix of sidecars) {
    if (existsSync(from + suffix)) copyFileSync(from + suffix, to + suffix);
    else rmSync(to + suffix, { force: true });
  }
}

function removeDb(path: string): void {
  for (const suffix of sidecars) rmSync(path + suffix, { force: true });
}

/** Stops the server, which closes app.db the way a clean shutdown does. */
async function stop(sim: Sim): Promise<void> {
  await sim.server.stop();
}

const roundOf = (jobs: { type: string; status: string }[]) =>
  jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job";

export default defineFlow({
  name: "customer-moves",
  description:
    "moving the data to another place, restoring a backup and losing the disk: reviews carry on and no pull request is reviewed twice",
  ai: AI,
  skipInherited: {
    "cost recorded for every AI call":
      "app.db is replaced on purpose, so the cost rows of the calls made before are gone",
  },
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await serveRepo(sim);
        return "served";
      },
    },
    {
      name: STEP.reviewed,
      async run(sim) {
        const round = await openPull(sim, {
          title: "First change",
          files: FILES,
        });
        sim.state.a = round.pull;
        sim.state.aDelivery = round.delivery.body;
        return `#${round.pull.number} · ${roundOf(round.jobs)}`;
      },
    },
    {
      name: STEP.moved,
      async run(sim) {
        const from = dbPath();
        const to = join(dirname(from), "moved", "app.db");
        await stop(sim);
        copyDb(from, to);
        removeDb(from);
        process.env.CM_APP_DB = to;
        await sim.server.start();
        const history = rows<{ n: number }>(
          "SELECT COUNT(*) AS n FROM jobs WHERE type = 'review' AND status = 'done'",
        )[0]!.n;
        sim.state.historyAfterMove = history;
        const reviewRows = rows<{ n: number }>(
          "SELECT COUNT(*) AS n FROM reviews WHERE posted_review_id IS NOT NULL",
        )[0]!.n;
        sim.state.reviewRowsAfterMove = reviewRows;
        return `moved to ${to} · ${history} finished review jobs · ${reviewRows} posted review rows`;
      },
    },
    {
      name: STEP.afterMove,
      async run(sim) {
        const b = await openPull(sim, { title: "Second change", files: FILES });
        sim.state.b = b.pull;
        const again = await deliverOpened(sim, pullOf(sim, "a"));
        sim.state.afterMoveRedelivery = roundOf(again.jobs);
        return `#${b.pull.number} · ${roundOf(b.jobs)} · first again: ${roundOf(again.jobs)}`;
      },
    },
    {
      name: STEP.backedUp,
      async run(sim) {
        await stop(sim);
        const backup = join(dirname(dbPath()), "backup", "app.db");
        copyDb(dbPath(), backup);
        sim.state.backup = backup;
        await sim.server.start();
        const c = await openPull(sim, { title: "Third change", files: FILES });
        sim.state.c = c.pull;
        return `#${c.pull.number} · ${roundOf(c.jobs)}`;
      },
    },
    {
      name: STEP.restored,
      async run(sim) {
        await stop(sim);
        copyDb(sim.state.backup as string, dbPath());
        await sim.server.start();
        const restart = await sim.server.restart();
        const known = rows<{ n: number }>(
          "SELECT COUNT(*) AS n FROM jobs WHERE type = 'review' AND pr_number = ?",
          pullOf(sim, "c").number,
        )[0]!.n;
        sim.state.cJobsAfterRestore = known;
        return `restored · recovered ${restart.orphans} · the third pull request has ${known} jobs in app.db`;
      },
    },
    {
      name: STEP.afterRestore,
      async run(sim) {
        const again = await deliverOpened(
          sim,
          pullOf(sim, "c"),
          "retry-of-third",
        );
        sim.state.cRedelivery = roundOf(again.jobs);
        // The job says why it stopped: the lookup on GitHub found the review.
        sim.state.cSkippedByLookup =
          rows<{ n: number }>(
            "SELECT COUNT(*) AS n FROM job_logs WHERE message LIKE '%GitHub already holds this app%'",
          )[0]!.n === 1;
        return `third again: ${roundOf(again.jobs)}`;
      },
    },
    {
      name: STEP.lost,
      async run(sim) {
        await stop(sim);
        removeDb(dbPath());
        await sim.server.start();
        const restart = await sim.server.restart();
        // The server found the guides on disk when it started: the repository
        // is listed again, with its guides, and with automatic review off.
        const repoRows = rows<{
          full_name: string;
          active: number;
          auto_review: number;
          knowledge_built_at: string | null;
          added_from: string | null;
        }>(
          "SELECT full_name, active, auto_review, knowledge_built_at, added_from FROM repos",
        );
        sim.state.repoAfterLoss = repoRows[0];
        const jobs = rows<{ n: number }>("SELECT COUNT(*) AS n FROM jobs")[0]!
          .n;
        sim.state.jobsAfterLoss = jobs;
        return `repo rows ${JSON.stringify(repoRows)} · an empty app.db · ${jobs} jobs · recovered ${restart.orphans} · swept ${restart.sweep.queued} queued`;
      },
    },
    {
      name: STEP.afterLoss,
      async run(sim) {
        const d = sim.github.openPull(APP_REPO, {
          title: "Fourth change",
          files: FILES,
        });
        sim.state.d = d;
        // With automatic review off nothing is posted, and the answer says why.
        const before = await sim.server.deliver(
          "pull_request",
          sim.server.payloads.pullRequest(d, "opened"),
          { deliveryId: "d-before-switch" },
        );
        sim.state.dBefore = before.body;
        sim.state.dReviewsBefore = botReviews(sim, d);
        // The owner switches automatic review on. The guides are not built
        // again.
        const { updateRepoSettings } = await import("../../../store/repos.ts");
        updateRepoSettings(APP_REPO, { auto_review: 1 });
        const round = await deliverOpened(sim, d, "d-after-switch");
        sim.state.dJobs = roundOf(round.jobs);
        sim.state.setupJobs = rows<{ n: number }>(
          "SELECT COUNT(*) AS n FROM jobs WHERE type IN ('init', 'setup', 'remake')",
        )[0]!.n;
        return `#${d.number} · before the switch: ${JSON.stringify(before.body)} · after: ${roundOf(round.jobs)}`;
      },
    },
  ],
  checks(sim): CheckResult[] {
    const reviews = (key: string) => botReviews(sim, pullOf(sim, key));
    const failed = rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'",
    )[0]!.n;
    return [
      check(
        "after the data is moved, the history came along and a new pull request is reviewed once",
        sim.state.historyAfterMove === 1 &&
          sim.state.reviewRowsAfterMove === 1 &&
          reviews("b") === 1,
        `${String(sim.state.historyAfterMove)} finished jobs · ${String(sim.state.reviewRowsAfterMove)} posted review rows · second pull request: ${reviews("b")} reviews`,
      ),
      check(
        "a webhook delivered again after the move starts no second review",
        reviews("a") === 1,
        `first pull request: ${reviews("a")} reviews, delivered again: ${String(sim.state.afterMoveRedelivery)}`,
      ),
      check(
        "a restored backup does not make the product review a commit it already reviewed: GitHub holds this App's review, so the webhook delivered again posts nothing",
        // The restore really happened (the third pull request has no job in
        // the restored database), the redelivery ran its job and found this
        // App's review of the commit on GitHub, and the pull request still
        // has one review.
        sim.state.cJobsAfterRestore === 0 &&
          String(sim.state.cRedelivery).includes("review done") &&
          sim.state.cSkippedByLookup === true &&
          reviews("c") === 1,
        `third pull request: ${reviews("c")} reviews, ${String(sim.state.cJobsAfterRestore)} jobs in the restored app.db, delivered again: ${String(sim.state.cRedelivery)}`,
      ),
      check(
        "after app.db is lost the repository is listed again from the guides on disk with automatic review off, and a review is skipped and says so",
        (
          sim.state.repoAfterLoss as
            | {
                active?: number;
                auto_review?: number;
                knowledge_built_at?: string | null;
              }
            | undefined
        )?.active === 1 &&
          (sim.state.repoAfterLoss as { auto_review?: number }).auto_review ===
            0 &&
          Boolean(
            (sim.state.repoAfterLoss as { knowledge_built_at?: string | null })
              .knowledge_built_at,
          ) &&
          (sim.state.dBefore as { reason?: string })?.reason ===
            "auto-review-off" &&
          sim.state.dReviewsBefore === 0,
        `repository ${JSON.stringify(sim.state.repoAfterLoss)} · the delivery was answered ${JSON.stringify(sim.state.dBefore)}`,
      ),
      check(
        "once automatic review is switched on the new pull request is reviewed once, no guides are built again, and the earlier ones are untouched",
        String(sim.state.dJobs).includes("review done") &&
          sim.state.setupJobs === 0 &&
          reviews("d") === 1 &&
          reviews("a") === 1 &&
          reviews("b") === 1,
        `after the switch: ${String(sim.state.dJobs)} · setup jobs ${String(sim.state.setupJobs)} · reviews: ${["a", "b", "c", "d"].map((key) => `${key} ${reviews(key)}`).join(", ")}`,
      ),
      check(
        "no review job failed in the new database",
        failed === 0,
        `${failed} failed jobs`,
      ),
    ];
  },
});
