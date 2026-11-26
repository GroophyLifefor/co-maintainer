/** Commit watch through the App: a push to the default branch is reviewed,
 * and what it finds becomes one issue.
 *
 * The flow pushes straight onto the default branch and delivers the `push`
 * webhook the way GitHub does. A push with a finding opens one issue. The same
 * delivery again opens no second one. A push with nothing wrong opens none.
 * A push to another branch is ignored.
 *
 * Every check reads GitHub's issues, check runs and writes and app.db rows,
 * never the model's wording, so the flow passes with a real model too. That
 * the scripted model reports a finding is its doing, so the two checks that
 * need one are `scriptedCheck`. */
import { finding } from "../fake_ai.ts";
import type { AiRule } from "../fake_ai.ts";
import { check, type CheckResult, defineFlow, scriptedCheck } from "../flow.ts";
import { APP_REPO, serveRepo, writesIn } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides",
  risky: "a push to the default branch with a flaw",
  again: "the same push delivered again",
  clean: "a push with nothing wrong",
  branch: "a push to another branch",
};

const RISKY = `export function ratio(a: number, b: number): number {
  return a / b;
}
`;

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "nothing wrong in the note push",
    job: "review_push",
    prompt: /docs\/NOTES\.md/,
    reply: { findings: [] },
  },
  {
    name: "the flaw in the ratio push",
    job: "review_push",
    prompt: /ratio/,
    reply: {
      findings: [
        finding({
          path: "src/ratio.ts",
          line: 2,
          severity: "P1",
          title: "ratio does not guard a zero divisor",
          body: "ratio returns Infinity when b is 0.",
        }),
      ],
    },
  },
];

type Sent = { jobs: { type: string; status: string }[]; ref: string };

function sent(sim: { state: Record<string, unknown> }, key: string): Sent {
  return sim.state[key] as Sent;
}

function commitChecks(
  sim: Parameters<typeof writesIn>[0],
  after: string,
): string[] {
  return sim.github.checkRuns
    .filter((run) => run.headSha === after)
    .map((run) => run.status);
}

function checks(sim: Parameters<typeof writesIn>[0]): CheckResult[] {
  const risky = sim.state.riskyAfter as string;
  const clean = sim.state.cleanAfter as string;
  const issues = sim.github.issues;
  const issuesAfterRisky = Number(sim.state.issuesAfterRisky ?? -1);
  return [
    scriptedCheck(
      sim,
      "a push with a flaw opens one issue",
      issuesAfterRisky === 1 && issues[0]?.state === "open",
      `${issuesAfterRisky} issues after the push · ${issues[0]?.state ?? "none"}`,
      "the scripted model reports the flaw",
    ),
    check(
      "the push review ran as a job and finished",
      sent(sim, "riskyJobs").jobs.some(
        (job) => job.type === "push_review" && job.status === "done",
      ),
      sent(sim, "riskyJobs")
        .jobs.map((job) => `${job.type} ${job.status}`)
        .join(", ") || "no job",
    ),
    check(
      "the commit watch check run on the pushed commit is completed",
      commitChecks(sim, risky).length > 0 &&
        commitChecks(sim, risky).every((status) => status === "completed"),
      commitChecks(sim, risky).join(", ") || "no check run",
    ),
    check(
      "the same delivery again makes no write and no new issue",
      writesIn(sim, STEP.again).length === 0 &&
        issues.length === issuesAfterRisky,
      `${writesIn(sim, STEP.again).length} writes · ${issues.length} issues`,
    ),
    scriptedCheck(
      sim,
      "a push with nothing wrong opens no issue",
      issues.length === issuesAfterRisky &&
        commitChecks(sim, clean).every((status) => status === "completed"),
      `${issues.length} issues · checks ${commitChecks(sim, clean).join(", ") || "none"}`,
      "the scripted model finds nothing in the second push",
    ),
    check(
      "a push to another branch is ignored: no job, no write",
      sent(sim, "branchJobs").jobs.length === 0 &&
        writesIn(sim, STEP.branch).length === 0,
      `${sent(sim, "branchJobs").jobs.length} jobs · ${writesIn(sim, STEP.branch).length} writes`,
    ),
  ];
}

export default defineFlow({
  name: "commit-watch",
  description:
    "a push to the default branch is reviewed and its finding becomes one issue, a repeat delivery or a clean push adds none, another branch is ignored",
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
      name: STEP.risky,
      async run(sim) {
        const range = sim.github.commitToDefault(
          APP_REPO,
          { "src/ratio.ts": RISKY },
          "Add ratio",
        );
        sim.state.riskyAfter = range.after;
        sim.state.riskyRange = range;
        await sim.server.deliver(
          "push",
          sim.server.payloads.push(APP_REPO, range.before, range.after),
          { deliveryId: "watch-risky" },
        );
        const jobs = await sim.server.runJobs();
        sim.state.riskyJobs = { jobs, ref: range.after } satisfies Sent;
        sim.state.issuesAfterRisky = sim.github.issues.length;
        return `${jobs.map((job) => `${job.type} ${job.status}`).join(", ")} · ${sim.github.issues.length} issues`;
      },
    },
    {
      name: STEP.again,
      async run(sim) {
        const range = sim.state.riskyRange as { before: string; after: string };
        await sim.server.deliver(
          "push",
          sim.server.payloads.push(APP_REPO, range.before, range.after),
          { deliveryId: "watch-risky" },
        );
        const jobs = await sim.server.runJobs();
        return `${jobs.length} jobs`;
      },
    },
    {
      name: STEP.clean,
      async run(sim) {
        const range = sim.github.commitToDefault(
          APP_REPO,
          { "docs/NOTES.md": "# Notes\n\nA plain note.\n" },
          "Add a note",
        );
        sim.state.cleanAfter = range.after;
        await sim.server.deliver(
          "push",
          sim.server.payloads.push(APP_REPO, range.before, range.after),
          { deliveryId: "watch-clean" },
        );
        const jobs = await sim.server.runJobs();
        return `${jobs.length} jobs · ${sim.github.issues.length} issues`;
      },
    },
    {
      name: STEP.branch,
      async run(sim) {
        const range = sim.state.riskyRange as { before: string; after: string };
        await sim.server.deliver(
          "push",
          sim.server.payloads.push(
            APP_REPO,
            range.before,
            range.after,
            "refs/heads/feature/other",
          ),
          { deliveryId: "watch-branch" },
        );
        const jobs = await sim.server.runJobs();
        sim.state.branchJobs = { jobs, ref: "" } satisfies Sent;
        return `${jobs.length} jobs`;
      },
    },
  ],
  checks,
});
