/** A CI step ends the way its result reads: a blocker a later round closed
 * no longer fails it, a server failure is exit code 3, not the usage code 2,
 * a push review's job summary carries its cost and time, a local review's
 * summary says it ran without the call graph, and a run with no terminal uses
 * the same defaults with or without `--json`.
 *
 * The checks read exit codes, the job summary and the product's own results,
 * never what the model answered, so a real model passes them too. */
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import { SAMPLE_REPO, SAMPLE_REPO_NAME } from "../sample_repo.ts";
import { INIT_AI } from "./init.ts";
import { clientCheckout } from "./remote_support.ts";
import {
  PUSH_AI,
  remoteSetupSteps,
  remoteState,
  runPushReview,
  runRemoteReview,
} from "./remote.ts";

const STEP = {
  exitRule: "the exit code counts only findings still open",
  serverFail: "a remote review the server fails",
  pushSummary: "the job summary of a push review",
  noTerminal: "a run with no terminal and no provider saved",
  workflow: "the dashboard's workflow names the remote token secret",
  summaryNotes: "the job summary carries warnings and the codegraph state",
};

const AI: AiRule[] = [
  ...INIT_AI,
  ...PUSH_AI,
  {
    name: "any local review",
    job: "review_local",
    prompt: /[\s\S]*/,
    reply: { findings: [] },
    optional: true,
  },
];

function checks(sim: Sim): CheckResult[] {
  const state = sim.state as Record<string, Record<string, unknown>>;
  const rule = state.exitRule ?? {};
  const fail = state.serverFail ?? {};
  const push = state.pushSummary ?? {};
  const noTerminal = state.noTerminal ?? {};
  const workflow = state.workflow ?? {};
  const notes = state.summaryNotes ?? {};
  return [
    check(
      "a blocking finding the carry-over closed does not fail the step, an open one does",
      rule.closedOnly === 0 && rule.openOne === 1,
      JSON.stringify(rule),
    ),
    check(
      "a remote review the server fails ends with exit code 3, not 2",
      fail.exit === 3,
      `exit ${String(fail.exit)}`,
    ),
    check(
      "a push review's job summary carries the cost and time line",
      push.exit === 0 && push.costLine === true,
      JSON.stringify(push),
    ),
    check(
      "with no terminal and no provider saved, init falls back to OpenRouter without --json too",
      noTerminal.ai === "openrouter",
      `provider ${String(noTerminal.ai)}`,
    ),
    check(
      "the workflow the dashboard offers names CO_MAINTAINER_REMOTE_TOKEN, never the AI key variable",
      workflow.remote === true && workflow.aiName === false,
      JSON.stringify(workflow),
    ),
    check(
      "the job summary lists the run's warnings and says when codegraph was off",
      notes.warning === true && notes.codegraph === true,
      JSON.stringify(notes),
    ),
  ];
}

export default defineFlow({
  name: "ci-exit",
  description:
    "CI exit codes and job summaries follow the result: closed blockers, server failures, push cost, no-terminal defaults",
  ai: AI,
  steps: [
    ...remoteSetupSteps(),
    {
      name: STEP.exitRule,
      async run(sim) {
        const { reviewExitCodeFromJsonFindings } =
          await import("../../../cli/review_result.ts");
        const finding = (state: string, blocking: boolean) =>
          ({ state, blocking }) as unknown as Parameters<
            typeof reviewExitCodeFromJsonFindings
          >[0][number];
        sim.state.exitRule = {
          closedOnly: reviewExitCodeFromJsonFindings([
            finding("closed", true),
            finding("new", false),
          ]),
          openOne: reviewExitCodeFromJsonFindings([
            finding("closed", true),
            finding("open", true),
          ]),
        };
        return JSON.stringify(sim.state.exitRule);
      },
    },
    {
      name: STEP.serverFail,
      async run(sim) {
        sim.faults.add({ target: "ai", kind: "500", job: "review_local" });
        const { dev } = remoteState(sim);
        const run = await runRemoteReview(sim, dev, ["--json", "--fresh"]);
        sim.state.serverFail = { exit: run.exitCode };
        return `exit ${run.exitCode}`;
      },
    },
    {
      name: STEP.pushSummary,
      async run(sim) {
        const range = sim.github.commitToDefault(
          SAMPLE_REPO_NAME,
          {
            "src/math.ts": `${SAMPLE_REPO["src/math.ts"]}\nexport function lerp(a: number, b: number, t: number): number {\n  return b + (a - b) * t;\n}\n`,
          },
          "Add lerp",
        );
        const ci = clientCheckout(sim, SAMPLE_REPO_NAME, "ci-summary");
        const path = sim.world.useStepSummary();
        rmSync(path, { force: true });
        const run = await runPushReview(sim, ci, range, ["--output=github"]);
        const summary = existsSync(path) ? readFileSync(path, "utf8") : "";
        sim.state.pushSummary = {
          exit: run.exitCode,
          costLine: /Done in .*tokens/.test(summary),
        };
        return JSON.stringify(sim.state.pushSummary);
      },
    },
    {
      name: STEP.noTerminal,
      async run(sim) {
        const { parseArgs, setCliInteractive } =
          await import("../../../cli/args.ts");
        const before = sim.world.readConfig();
        sim.world.writeConfig({ ai: undefined });
        setCliInteractive(true);
        try {
          const options = await parseArgs([
            "init",
            "sim/no-terminal",
            "--auth=gh",
            "--token=sim-unused-key",
            "--low-model=a",
            "--high-model=b",
            "--max-pr-months=1",
          ]);
          sim.state.noTerminal = { ai: options.ai };
        } finally {
          sim.world.writeConfig({ ai: before.ai });
        }
        return JSON.stringify(sim.state.noTerminal);
      },
    },
    {
      name: STEP.workflow,
      async run(sim) {
        const { commitWatchWorkflow } =
          await import("../../../server/pages/repo_pushes.ts");
        const yaml = commitWatchWorkflow("https://review.example.com", "main");
        sim.state.workflow = {
          remote: yaml.includes("secrets.CO_MAINTAINER_REMOTE_TOKEN"),
          aiName: /secrets\.CO_MAINTAINER_TOKEN\b/.test(yaml),
        };
        return JSON.stringify(sim.state.workflow);
      },
    },
    {
      name: STEP.summaryNotes,
      async run(sim) {
        const { githubSummary } = await import("../../../cli/review_github.ts");
        const summary = githubSummary({
          title: "sim/sample · feature",
          findings: [],
          warnings: [
            { code: "guide_stale", message: "The guide is 40 days old." },
          ],
          codegraphState: "disabled",
        });
        sim.state.summaryNotes = {
          warning: summary.includes("The guide is 40 days old."),
          codegraph: summary.includes("Codegraph: off for this review."),
        };
        return JSON.stringify(sim.state.summaryNotes);
      },
    },
  ],
  checks,
});
