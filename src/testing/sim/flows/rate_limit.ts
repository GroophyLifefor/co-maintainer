/** GitHub rate limits during an App review and during `init` (issue 151).
 *
 * GitHub answers a rate limit with a 403 or a 429. A primary limit carries
 * `x-ratelimit-remaining: 0` and the reset time, a secondary limit carries
 * `retry-after`. The product waits and tries the same call again. A limit
 * that outlives the retries fails the review as a temporary error. It must
 * never read as missing access, which would post the public access-denied
 * comment.
 *
 * The waits are not slept. The sim logs the wait the product asked for, and
 * a check reads it. Every other check reads the GitHub calls, the writes, the
 * check run, the job and the review row, never what the model answered, so
 * the flow passes with a real model too. */
import type { AiRule } from "../fake_ai.ts";
import {
  check,
  type CheckResult,
  defineFlow,
  RATE_LIMIT_WAIT_LOG,
  type Sim,
} from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, OPENED_MATH, appRows, serveRepo, writesIn } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides",
  primary: "a primary limit on the files, resetting in a minute",
  secondaryOnce: "a secondary limit on the review post, once",
  secondarySpent: "a secondary limit on the review post, three times",
  bodyOnly: "a rate limit 403 on the files with no limit headers",
  secondaryBare:
    "a secondary limit on the files with neither retry-after nor limit headers",
  init: "init with a token meets a primary limit on the tree",
};

const INIT_REPO = "sim/rate-limited";
const ACCESS_DENIED =
  "The App does not have access to review this pull request.";
const SECONDARY = "You have exceeded a secondary rate limit.";
const PRIMARY_BODY = "API rate limit exceeded for installation.";

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "any review",
    job: "review_pull_request",
    prompt: /[\s\S]*/,
    reply: { findings: [] },
  },
];

/** Opens a pull request, delivers `opened` and runs the jobs it queued. */
async function review(sim: Sim, key: string, title: string): Promise<string> {
  const pull = sim.github.openPull(APP_REPO, {
    title,
    files: { "src/math.ts": OPENED_MATH },
  });
  sim.state[key] = pull;
  const delivery = await sim.server.deliver(
    "pull_request",
    sim.server.payloads.pullRequest(pull, "opened"),
  );
  const jobs = await sim.server.runJobs();
  return `#${pull.number} · ${String(delivery.body.outcome)} · ${jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job"}`;
}

const pullAt = (sim: Sim, key: string) => sim.state[key] as SimPull;

/** The waits the product asked for while `step` ran, in ms. */
function waitsIn(sim: Sim, step: string): number[] {
  return sim.trace.logs
    .filter(
      (line) =>
        line.step === step && line.message.startsWith(RATE_LIMIT_WAIT_LOG),
    )
    .map((line) =>
      Number.parseInt(line.message.slice(RATE_LIMIT_WAIT_LOG.length), 10),
    );
}

/** GitHub calls to `path` while `step` ran, as `status` or `fault`. */
function callsTo(sim: Sim, step: string, method: string, path: RegExp) {
  return sim.trace.github
    .filter(
      (call) =>
        call.step === step &&
        call.method === method &&
        path.test(new URL(call.url).pathname),
    )
    .map((call) => ({ status: call.status, fault: call.fault }));
}

function jobsIn(sim: Sim, step: string): string[] {
  return sim.trace.jobs
    .filter((job) => job.step === step)
    .map((job) => `${job.type} ${job.status}`);
}

function reviewPosts(sim: Sim, step: string, pull: SimPull) {
  return writesIn(sim, step).filter(
    (write) =>
      write.method === "POST" &&
      write.path.endsWith(`/pulls/${pull.number}/reviews`),
  );
}

function commentBodies(sim: Sim, step: string): string[] {
  return writesIn(sim, step)
    .filter((write) => /issues\/\d+\/comments$/.test(write.path))
    .map((write) => String((write.body as { body?: unknown }).body ?? ""));
}

function checkRun(sim: Sim, pull: SimPull) {
  return sim.github.checkRuns.find((run) => run.headSha === pull.headSha);
}

function reviewStatus(sim: Sim, pull: SimPull): string {
  return (
    appRows<{ status: string }>(
      sim,
      `SELECT status FROM reviews WHERE repo = ? AND pr_number = ? ORDER BY rowid DESC`,
      APP_REPO,
      pull.number,
    )[0]?.status ?? "no row"
  );
}

function rateLimitRows(sim: Sim, pull: SimPull): number {
  return appRows<{ n: number }>(
    sim,
    `SELECT COUNT(*) AS n FROM job_logs WHERE message LIKE '%rate_limit_wait%' AND job_id IN (SELECT job_id FROM reviews WHERE repo = ? AND pr_number = ?)`,
    APP_REPO,
    pull.number,
  )[0]!.n;
}

/** What a review step left: the check, the job, the row and the comments. */
function outcome(sim: Sim, step: string, pull: SimPull): string {
  const run = checkRun(sim, pull);
  return `${jobsIn(sim, step).join(", ") || "no job"} · check ${run?.status ?? "none"} ${run?.conclusion ?? ""} · review row ${reviewStatus(sim, pull)} · ${reviewPosts(sim, step, pull).length} reviews · ${commentBodies(sim, step).length} comments`;
}

const FILES = /\/pulls\/\d+\/files$/;
const REVIEWS = /\/pulls\/\d+\/reviews$/;

function checks(sim: Sim): CheckResult[] {
  const primary = pullAt(sim, "primary");
  const once = pullAt(sim, "once");
  const spent = pullAt(sim, "spent");
  const bodyOnly = pullAt(sim, "bodyOnly");
  const bare = pullAt(sim, "secondaryBare");
  const bareWaits = waitsIn(sim, STEP.secondaryBare);
  const primaryFiles = callsTo(sim, STEP.primary, "GET", FILES);
  const primaryWaits = waitsIn(sim, STEP.primary);
  const onceWaits = waitsIn(sim, STEP.secondaryOnce);
  const spentWaits = waitsIn(sim, STEP.secondarySpent);
  const spentPosts = callsTo(sim, STEP.secondarySpent, "POST", REVIEWS);
  const initTrees = callsTo(sim, STEP.init, "GET", /\/git\/trees\//);
  const initWaits = waitsIn(sim, STEP.init);
  const allComments = [
    ...commentBodies(sim, STEP.secondarySpent),
    ...commentBodies(sim, STEP.bodyOnly),
    ...commentBodies(sim, STEP.secondaryBare),
  ];
  return [
    check(
      "a primary limit: the product waits for the reset, then reads the files again and the review posts once",
      primaryFiles.some((call) => call.fault === "rate-limit") &&
        primaryFiles.some((call) => call.status === 200) &&
        primaryWaits.length === 1 &&
        primaryWaits[0]! > 0 &&
        primaryWaits[0]! <= 60_000 &&
        reviewPosts(sim, STEP.primary, primary).length === 1 &&
        jobsIn(sim, STEP.primary).includes("review done") &&
        checkRun(sim, primary)?.status === "completed",
      `${primaryFiles.map((call) => call.fault ?? call.status).join(", ")} · waits ${primaryWaits.join(", ") || "none"} ms · ${outcome(sim, STEP.primary, primary)}`,
    ),
    check(
      "a primary limit wait is on the job's log, where Usage reads it",
      rateLimitRows(sim, primary) >= 1,
      `${rateLimitRows(sim, primary)} rate limit rows`,
    ),
    check(
      "a secondary limit once: the product waits retry-after and the review posts exactly once",
      onceWaits.length === 1 &&
        onceWaits[0] === 5_000 &&
        reviewPosts(sim, STEP.secondaryOnce, once).length === 1 &&
        jobsIn(sim, STEP.secondaryOnce).includes("review done"),
      `waits ${onceWaits.join(", ") || "none"} ms · ${outcome(sim, STEP.secondaryOnce, once)}`,
    ),
    check(
      "a secondary limit three times: three tries with two waits, nothing posted, the job fails and the review row says not posted",
      spentPosts.length === 3 &&
        spentWaits.length === 2 &&
        reviewPosts(sim, STEP.secondarySpent, spent).length === 0 &&
        jobsIn(sim, STEP.secondarySpent).includes("review failed") &&
        reviewStatus(sim, spent) === "not_posted" &&
        checkRun(sim, spent)?.conclusion !== "success",
      `${spentPosts.length} tries · waits ${spentWaits.join(", ") || "none"} ms · ${outcome(sim, STEP.secondarySpent, spent)}`,
    ),
    check(
      "a rate limit 403 with no limit headers fails the review as temporary, not as missing access, and the review row says failed",
      jobsIn(sim, STEP.bodyOnly).includes("review failed") &&
        reviewStatus(sim, bodyOnly) === "failed" &&
        checkRun(sim, bodyOnly)?.output?.title !==
          "Review could not access the pull request files.",
      outcome(sim, STEP.bodyOnly, bodyOnly),
    ),
    check(
      "a secondary limit with no retry-after waits a minute and the review posts once, it does not fail",
      bareWaits.length === 1 &&
        bareWaits[0]! >= 60_000 &&
        bareWaits[0]! <= 72_000 &&
        reviewPosts(sim, STEP.secondaryBare, bare).length === 1 &&
        jobsIn(sim, STEP.secondaryBare).includes("review done"),
      `waits ${bareWaits.join(", ") || "none"} ms · ${outcome(sim, STEP.secondaryBare, bare)}`,
    ),
    check(
      "no rate limit posts the access-denied comment",
      !allComments.some((body) => body.includes(ACCESS_DENIED)),
      `${allComments.length} comments read`,
    ),
    check(
      "init with a token: waits for the reset, reads the tree again and finishes",
      initTrees.some((call) => call.fault === "rate-limit") &&
        initTrees.some((call) => call.status === 200) &&
        initWaits.length === 1 &&
        initWaits[0]! > 0 &&
        initWaits[0]! <= 120_000 &&
        sim.state.initDone === true,
      `${initTrees.map((call) => call.fault ?? call.status).join(", ")} · waits ${initWaits.join(", ") || "none"} ms · ${String(sim.state.initDone ?? "not done")}`,
    ),
  ];
}

export default defineFlow({
  name: "rate-limit",
  description:
    "GitHub primary and secondary rate limits during an App review and init: waits, retries, and never read as missing access",
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
      name: STEP.primary,
      run(sim) {
        sim.faults.add({
          target: "github",
          kind: "rate-limit",
          method: "GET",
          path: FILES,
          resetIn: 60,
        });
        return review(sim, "primary", "Add divide and average");
      },
    },
    {
      name: STEP.secondaryOnce,
      run(sim) {
        sim.faults.add({
          target: "github",
          kind: 403,
          method: "POST",
          path: REVIEWS,
          message: SECONDARY,
          headers: { "retry-after": "5" },
        });
        return review(sim, "once", "Add divide and average again");
      },
    },
    {
      name: STEP.secondarySpent,
      run(sim) {
        sim.faults.add({
          target: "github",
          kind: 403,
          method: "POST",
          path: REVIEWS,
          message: SECONDARY,
          headers: { "retry-after": "5" },
          times: 3,
        });
        return review(sim, "spent", "Add divide and average a third time");
      },
    },
    {
      name: STEP.bodyOnly,
      run(sim) {
        sim.faults.add({
          target: "github",
          kind: 403,
          method: "GET",
          path: FILES,
          message: PRIMARY_BODY,
        });
        return review(sim, "bodyOnly", "Add divide and average a fourth time");
      },
    },
    {
      name: STEP.secondaryBare,
      run(sim) {
        sim.faults.add({
          target: "github",
          kind: 403,
          method: "GET",
          path: FILES,
          message: SECONDARY,
        });
        return review(
          sim,
          "secondaryBare",
          "Add divide and average a fifth time",
        );
      },
    },
    {
      name: STEP.init,
      async run(sim) {
        sim.repo(INIT_REPO);
        sim.faults.add({
          target: "github",
          kind: "rate-limit",
          method: "GET",
          path: /\/git\/trees\//,
          resetIn: 120,
        });
        const { runInitOrRemake } = await import("../../../services/setup.ts");
        await runInitOrRemake(
          sim.options({ command: "init", repo: INIT_REPO }),
        );
        sim.state.initDone = true;
        return `${INIT_REPO} · init finished`;
      },
    },
  ],
  checks,
});
