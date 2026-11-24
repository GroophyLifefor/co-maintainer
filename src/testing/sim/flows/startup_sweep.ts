/** `serve` catches up on pull requests it left blocked while it was down
 * (issue 159).
 *
 * GitHub does not redeliver a webhook that failed. The flow pushes to a
 * blocked pull request without delivering the webhook, the way a push looks
 * to a server that is down, then starts the server again with the product's
 * own startup code. The new head is reviewed once, and a second start does
 * nothing. A pull request closed while down is left alone. A blocking
 * finding closed in app.db whose approval never reached GitHub is approved
 * once, however many times the server starts.
 *
 * Every check reads GitHub's reviews, the writes, the webhook deliveries and
 * app.db rows, never what the model answered, so the flow passes with a real
 * model too. That the first review blocks is the scripted model's doing, so
 * it and the two checks that need a blocking review are `scriptedCheck`. */
import { finding } from "../fake_ai.ts";
import type { AiRule } from "../fake_ai.ts";
import {
  check,
  type CheckResult,
  defineFlow,
  scriptedCheck,
  type Sim,
} from "../flow.ts";
import type { SimPull } from "../github.ts";
import {
  APP_REPO,
  FIXED_MATH,
  OPENED_MATH,
  appRows,
  serveRepo,
  writesIn,
} from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides",
  blocked: "a review that blocks",
  pushedDown: "a push while the server is down, then a start",
  startAgain: "the server starts again",
  closedDown: "a blocked pull request closed while the server is down",
  approvalOwed: "a finding closed in app.db whose approval never posted",
  startTwice: "the server starts twice more",
  crashMoved: "a crash while reviewing, a push while down, then a start",
};

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "one blocking finding",
    job: "review_pull_request",
    prompt: /[\s\S]*/,
    reply: {
      findings: [
        finding({
          path: "src/math.ts",
          line: 10,
          severity: "P1",
          blocking: true,
          title: "divide does not guard a zero divisor",
          body: "divide returns Infinity when b is 0.",
        }),
      ],
    },
  },
];

async function openBlocked(sim: Sim, key: string, title: string) {
  const pull = sim.github.openPull(APP_REPO, {
    title,
    files: { "src/math.ts": OPENED_MATH },
  });
  sim.state[key] = pull;
  await sim.server.deliver(
    "pull_request",
    sim.server.payloads.pullRequest(pull, "opened"),
  );
  const jobs = await sim.server.runJobs();
  return `#${pull.number} · ${jobs.map((job) => `${job.type} ${job.status}`).join(", ")}`;
}

async function start(sim: Sim): Promise<string> {
  const restart = await sim.server.restart();
  const jobs = [...restart.finished, ...(await sim.server.runJobs())];
  const { queued, approved, closedChecks } = restart.sweep;
  return `sweep queued ${queued}, approved ${approved}, closed ${closedChecks} · ${jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job"}`;
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

function jobsIn(sim: Sim, step: string): string[] {
  return sim.trace.jobs
    .filter((job) => job.step === step)
    .map((job) => `${job.type} ${job.status}`);
}

function webhooksIn(sim: Sim, step: string): number {
  return sim.trace.webhooks.filter((hook) => hook.step === step).length;
}

function checks(sim: Sim): CheckResult[] {
  const blocked = pullAt(sim, "blocked");
  const closed = pullAt(sim, "closed");
  const owed = pullAt(sim, "owed");
  const head = String(sim.state.newHead ?? "");
  const onNewHead = botReviews(sim, blocked).filter(
    (review) => review.commitId === head,
  );
  const rowHeads = appRows<{ head_sha: string }>(
    sim,
    `SELECT head_sha FROM reviews WHERE repo = ? AND pr_number = ? ORDER BY created_at`,
    APP_REPO,
    blocked.number,
  ).map((row) => row.head_sha);
  // Writes and jobs after the closed pull request's start, less what the
  // later steps made on their own.
  const closedWrites = Number(sim.state.writesBeforeClosedStart ?? 0);
  const closedJobs = Number(sim.state.jobsBeforeClosedStart ?? 0);
  const later = [STEP.approvalOwed, STEP.startTwice, STEP.crashMoved];
  const laterWrites = sim.github.writes.filter((write) =>
    later.includes(write.step),
  ).length;
  const laterJobs = sim.trace.jobs.filter((job) =>
    later.includes(job.step),
  ).length;
  const moved = pullAt(sim, "moved");
  const movedOld = String(sim.state.movedOldHead ?? "");
  const movedReviews = botReviews(sim, moved);
  const movedRows = appRows<{ head_sha: string }>(
    sim,
    `SELECT head_sha FROM reviews WHERE repo = ? AND pr_number = ?`,
    APP_REPO,
    moved.number,
  ).map((row) => row.head_sha);
  const oldChecks = sim.github.checkRuns.filter(
    (run) => run.headSha === movedOld,
  );
  const newChecks = sim.github.checkRuns.filter(
    (run) => run.headSha === moved.headSha,
  );
  const approvals = botReviews(sim, owed).filter(
    (review) => review.state === "APPROVED",
  );
  return [
    scriptedCheck(
      sim,
      "the first review blocks the pull request",
      botReviews(sim, blocked)[0]?.state === "CHANGES_REQUESTED",
      botReviews(sim, blocked)[0]?.state ?? "no review",
      "the scripted model reports one blocking finding",
    ),
    scriptedCheck(
      sim,
      "a push while down: no webhook arrived, and the start reviewed the new head once",
      webhooksIn(sim, STEP.pushedDown) === 0 &&
        onNewHead.length === 1 &&
        rowHeads.filter((sha) => sha === head).length === 1 &&
        jobsIn(sim, STEP.pushedDown).includes("review done"),
      `${webhooksIn(sim, STEP.pushedDown)} webhooks · ${onNewHead.length} reviews on the new head · rows ${rowHeads.map((sha) => sha.slice(0, 7)).join(", ")} · ${jobsIn(sim, STEP.pushedDown).join(", ") || "no job"}`,
      "the sweep acts only on a review that blocks, and the scripted model blocks",
    ),
    check(
      "the next start finds nothing to do: no write, no job",
      writesIn(sim, STEP.startAgain).length === 0 &&
        jobsIn(sim, STEP.startAgain).length === 0,
      `${writesIn(sim, STEP.startAgain).length} writes · ${jobsIn(sim, STEP.startAgain).join(", ") || "no job"}`,
    ),
    check(
      "a pull request closed while down is left alone",
      botReviews(sim, closed).length === 1 &&
        sim.github.writes.length - closedWrites === laterWrites &&
        sim.trace.jobs.length - closedJobs === laterJobs,
      `${botReviews(sim, closed).length} reviews · ${sim.github.writes.length - closedWrites - laterWrites} writes after the start`,
    ),
    check(
      "a review cut off by a crash reviews the head GitHub has after the push: the row and one review move to it, the old commit's check run is closed",
      movedReviews.length === 1 &&
        movedReviews[0]!.commitId === moved.headSha &&
        movedRows.length === 1 &&
        movedRows[0] === moved.headSha &&
        oldChecks.length > 0 &&
        oldChecks.every((run) => run.status === "completed") &&
        newChecks.length === 1 &&
        newChecks[0]!.status === "completed",
      `${movedReviews.length} reviews on ${movedReviews.map((r) => r.commitId.slice(0, 7)).join(", ") || "none"} · rows ${movedRows.map((sha) => sha.slice(0, 7)).join(", ")} · old checks ${oldChecks.map((run) => run.status).join(", ") || "none"} · new checks ${newChecks.map((run) => run.status).join(", ") || "none"}`,
    ),
    scriptedCheck(
      sim,
      "the approval a closed finding owed is posted once over three starts",
      approvals.length === 1 &&
        approvals[0]!.commitId === owed.headSha &&
        writesIn(sim, STEP.startTwice).length === 0,
      `${approvals.length} approvals · ${writesIn(sim, STEP.startTwice).length} writes in the later starts`,
      "an approval is owed only after a blocking review, and the scripted model blocks",
    ),
  ];
}

export default defineFlow({
  name: "startup-sweep",
  description:
    "serve catches up on pull requests left blocked while it was down: a missed push is reviewed once, a missed approval posts once",
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
      name: STEP.blocked,
      run: (sim) => openBlocked(sim, "blocked", "Add divide and average"),
    },
    {
      name: STEP.pushedDown,
      async run(sim) {
        const pull = pullAt(sim, "blocked");
        sim.github.push(pull, { "src/math.ts": FIXED_MATH }, "guard b");
        sim.state.newHead = pull.headSha;
        return `#${pull.number} at ${pull.headSha.slice(0, 7)} · ${await start(sim)}`;
      },
    },
    { name: STEP.startAgain, run: (sim) => start(sim) },
    {
      name: STEP.closedDown,
      async run(sim) {
        await openBlocked(sim, "closed", "Add divide again");
        const pull = pullAt(sim, "closed");
        sim.github.close(pull);
        sim.state.writesBeforeClosedStart = sim.github.writes.length;
        sim.state.jobsBeforeClosedStart = sim.trace.jobs.length;
        return `#${pull.number} closed · ${await start(sim)}`;
      },
    },
    {
      name: STEP.approvalOwed,
      async run(sim) {
        await openBlocked(sim, "owed", "Add divide a third time");
        const pull = pullAt(sim, "owed");
        const { withdrawFinding } = await import("../../../store/findings.ts");
        const rows = appRows<{ id: string }>(
          sim,
          `SELECT f.id FROM findings f JOIN reviews r ON r.id = f.review_id WHERE r.repo = ? AND r.pr_number = ?`,
          APP_REPO,
          pull.number,
        );
        for (const row of rows) withdrawFinding(row.id);
        return `#${pull.number} · ${rows.length} withdrawn in app.db · ${await start(sim)}`;
      },
    },
    {
      name: STEP.crashMoved,
      async run(sim) {
        sim.faults.add({
          target: "github",
          kind: "hang",
          method: "GET",
          path: /\/pulls\/\d+\/files$/,
        });
        const pull = sim.github.openPull(APP_REPO, {
          title: "Add divide a fourth time",
          files: { "src/math.ts": OPENED_MATH },
        });
        sim.state.moved = pull;
        sim.state.movedOldHead = pull.headSha;
        await sim.server.deliver(
          "pull_request",
          sim.server.payloads.pullRequest(pull, "opened"),
        );
        await sim.server.crashDuringJob(sim.faults);
        sim.github.push(pull, { "src/math.ts": FIXED_MATH }, "guard b");
        return `#${pull.number} · ${await start(sim)}`;
      },
    },
    {
      name: STEP.startTwice,
      async run(sim) {
        return `${await start(sim)} · ${await start(sim)}`;
      },
    },
  ],
  checks,
});
