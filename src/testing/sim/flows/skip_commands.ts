/** `/co-maintainer skip-this-commit` and `/co-maintainer skip-this-pr` from a
 * signed comment webhook, end to end through `serve`. A failed review is
 * skipped by the owner, a member who is not allowed is ignored, reviews are
 * turned off, a commit while they are off gets a skipped check and no review,
 * and `/co-maintainer review` turns them back on.
 *
 * Every check reads what the product wrote, never what the model answered,
 * so the flow passes with a real model too. */
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, OPENED_MATH, appRows, serveRepo, writesIn } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides",
  failed: "a review that fails",
  member: "a member asks to skip",
  skipCommit: "the owner skips the failed commit",
  off: "the owner turns reviews off",
  pushed: "a commit while reviews are off",
  on: "the owner asks for a review",
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

/** The owner, or anyone else, comments on the pull request, and the jobs the
 * webhook queued run. */
async function say(
  sim: Sim,
  body: string,
  association: string,
): Promise<string> {
  const pull = pullOf(sim);
  const comment = sim.github.comment(pull, body, "sim-commenter", association);
  const delivery = await sim.server.deliver(
    "issue_comment",
    sim.server.payloads.issueComment(pull, comment),
  );
  const jobs = await sim.server.runJobs();
  return `${String(delivery.body.outcome)} · ${jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job"}`;
}

function bodies(sim: Sim, step: string, path: RegExp): string[] {
  return writesIn(sim, step)
    .filter((write) => path.test(write.path))
    .map((write) => String((write.body as { body?: unknown }).body ?? ""));
}

function skippedRuns(sim: Sim, step: string): { headSha: string }[] {
  return writesIn(sim, step)
    .filter(
      (write) =>
        write.method === "POST" &&
        /check-runs$/.test(write.path) &&
        (write.body as { conclusion?: unknown }).conclusion === "skipped",
    )
    .map((write) => ({
      headSha: String((write.body as { head_sha?: unknown }).head_sha),
    }));
}

function jobsIn(sim: Sim, step: string): string[] {
  return sim.trace.jobs
    .filter((job) => job.step === step)
    .map((job) => `${job.type} ${job.status}`);
}

function checks(sim: Sim): CheckResult[] {
  const failedHead = String(sim.state.failedHead ?? "");
  const pushedHead = String(sim.state.pushedHead ?? "");
  const memberWrites = writesIn(sim, STEP.member);
  const notePatch = bodies(sim, STEP.skipCommit, /issues\/comments\/\d+$/);
  const offReplies = bodies(sim, STEP.off, /issues\/\d+\/comments$/);
  const onReplies = bodies(sim, STEP.on, /issues\/\d+\/comments$/);
  const offBy = sim.state.offBy as string | null | undefined;
  return [
    check(
      "a member the policy does not list is ignored: no job, no reply, no reaction",
      jobsIn(sim, STEP.member).length === 0 && memberWrites.length === 0,
      `${jobsIn(sim, STEP.member).join(", ") || "no job"} · ${memberWrites.length} writes`,
    ),
    check(
      "skip-this-commit after a failed review: a skipped check on that commit, and the failed note says it was skipped",
      skippedRuns(sim, STEP.skipCommit).some(
        (run) => run.headSha === failedHead,
      ) &&
        notePatch.some((body) =>
          body.includes(`skipped the review of \`${failedHead.slice(0, 7)}\``),
        ),
      `${skippedRuns(sim, STEP.skipCommit).length} skipped check runs · note ${notePatch[0]?.slice(0, 60) ?? "not edited"}`,
    ),
    check(
      "skip-this-pr: reviews are off, the head gets a skipped check, and one reply says how to turn them back on",
      offBy === "sim-commenter" &&
        skippedRuns(sim, STEP.off).length === 1 &&
        offReplies.length === 1 &&
        offReplies[0]!.includes("turned co-maintainer reviews off") &&
        offReplies[0]!.includes("`/co-maintainer review`"),
      `off by ${offBy ?? "nobody"} · ${skippedRuns(sim, STEP.off).length} skipped · ${offReplies.length} replies`,
    ),
    check(
      "a commit while reviews are off: no review, and a skipped check on the new head",
      !jobsIn(sim, STEP.pushed).some((job) => job.startsWith("review ")) &&
        skippedRuns(sim, STEP.pushed).some((run) => run.headSha === pushedHead),
      `${jobsIn(sim, STEP.pushed).join(", ") || "no job"} · ${skippedRuns(sim, STEP.pushed).length} skipped`,
    ),
    check(
      "/co-maintainer review turns reviews back on, says so, and the review runs",
      onReplies.some((body) =>
        body.includes("turned co-maintainer reviews back on"),
      ) && jobsIn(sim, STEP.on).includes("review done"),
      `${jobsIn(sim, STEP.on).join(", ")} · ${onReplies.length} replies`,
    ),
    check(
      "no reply carries an em dash or a semicolon",
      [...notePatch, ...offReplies, ...onReplies].every(
        (body) =>
          !body.includes(String.fromCharCode(0x2014)) &&
          !body.includes(String.fromCharCode(59)),
      ),
      `${notePatch.length + offReplies.length + onReplies.length} replies read`,
    ),
  ];
}

export default defineFlow({
  name: "skip-commands",
  description:
    "skip a failed App review, turn reviews off for a pull request and back on, by comment",
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
      name: STEP.failed,
      async run(sim) {
        sim.faults.add({
          target: "ai",
          kind: "500",
          job: "review_pull_request",
        });
        const pull = sim.github.openPull(APP_REPO, {
          title: "Add divide and average",
          files: { "src/math.ts": OPENED_MATH },
        });
        sim.state.pull = pull;
        sim.state.failedHead = pull.headSha;
        const delivery = await sim.server.deliver(
          "pull_request",
          sim.server.payloads.pullRequest(pull, "opened"),
        );
        const jobs = await sim.server.runJobs();
        return `${String(delivery.body.outcome)} · ${jobs.map((job) => `${job.type} ${job.status}`).join(", ")}`;
      },
    },
    {
      name: STEP.member,
      run: (sim) => say(sim, "/co-maintainer skip-this-commit", "MEMBER"),
    },
    {
      name: STEP.skipCommit,
      run: (sim) => say(sim, "/co-maintainer skip-this-commit", "OWNER"),
    },
    {
      name: STEP.off,
      async run(sim) {
        const line = await say(sim, "/co-maintainer skip-this-pr", "OWNER");
        // Read now: the last step turns reviews back on.
        sim.state.offBy =
          appRows<{ reviews_off_by: string | null }>(
            sim,
            `SELECT reviews_off_by FROM subjects WHERE kind = 'pr' AND repo = ? AND pr_number = ?`,
            APP_REPO,
            pullOf(sim).number,
          )[0]?.reviews_off_by ?? null;
        return line;
      },
    },
    {
      name: STEP.pushed,
      async run(sim) {
        const pull = pullOf(sim);
        sim.github.push(
          pull,
          { "src/math.ts": `${OPENED_MATH}\nexport const one = 1;\n` },
          "more",
        );
        sim.state.pushedHead = pull.headSha;
        const delivery = await sim.server.deliver(
          "pull_request",
          sim.server.payloads.pullRequest(pull, "synchronize"),
        );
        const jobs = await sim.server.runJobs();
        return `${String(delivery.body.outcome)} · ${jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job"}`;
      },
    },
    {
      name: STEP.on,
      run: (sim) => say(sim, "/co-maintainer review", "OWNER"),
    },
  ],
  checks,
});
