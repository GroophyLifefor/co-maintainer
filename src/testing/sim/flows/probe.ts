/** `co-maintainer probe`, end to end: read-only, with no AI call.
 *
 * probe reads a repository and recommends the `init` command, with its time,
 * GitHub calls and cost. The flow runs it on the sample repository with
 * pull requests on the simulated GitHub, in human and `--json` output, and on
 * a repository that does not exist. The checks read the exit codes, the JSON,
 * what probe asked GitHub and what it wrote, never a model's answer: probe
 * asks no model, it only reads the provider's price list. */
import {
  check,
  type CheckResult,
  type CliRun,
  defineFlow,
  type Sim,
} from "../flow.ts";
import { SAMPLE_REPO, SAMPLE_REPO_NAME } from "../sample_repo.ts";
import { aiFlags, parseJsonOutput } from "./cli_pr.ts";
import { INIT_SYNC_AI } from "./init_sync.ts";

const STEP = {
  repo: "a repository with merged pull requests",
  human: "probe in human output",
  json: "probe --json",
  missing: "probe on a repository that does not exist",
  init: "the recommended init runs",
};

type Json = Record<string, unknown>;

const runAt = (sim: Sim, key: string) => sim.state[key] as CliRun;

function githubIn(sim: Sim, step: string) {
  return sim.trace.github.filter((call) => call.step === step);
}

function writesIn(sim: Sim, step: string) {
  return sim.github.writes.filter((write) => write.step === step);
}

function checks(sim: Sim): CheckResult[] {
  const human = runAt(sim, "human");
  const json = runAt(sim, "json");
  const missing = runAt(sim, "missing");
  const doc = parseJsonOutput(json.stdout) as Json | undefined;
  const init = sim.state.init as CliRun | undefined;
  const estimated = Number(
    ((doc?.estimate as Json | undefined)?.github as Json | undefined)?.calls ??
      0,
  );
  const recommended = String(
    (doc?.recommended as Json | undefined)?.command ?? doc?.recommended ?? "",
  );
  const aiCalls = sim.trace.ai.filter((call) =>
    [STEP.human, STEP.json, STEP.missing].includes(call.step),
  );
  const probeSteps = [STEP.human, STEP.json, STEP.missing];
  const completions = sim.trace.completions.filter((call) =>
    probeSteps.includes(call.step),
  );
  const writes = probeSteps.flatMap((step) => writesIn(sim, step));
  return [
    check(
      "probe exits 0 and recommends an init command for the repository",
      human.exitCode === 0 &&
        new RegExp(`co-maintainer init ${SAMPLE_REPO_NAME}`).test(
          human.stdout + human.stderr,
        ),
      `exit ${human.exitCode}`,
    ),
    check(
      "probe --json prints one document: ok, the repo, a recommended init command and an estimate",
      json.exitCode === 0 &&
        doc?.ok === true &&
        doc.command === "probe" &&
        doc.repo === SAMPLE_REPO_NAME &&
        /init/.test(JSON.stringify(doc.recommended)) &&
        typeof doc.estimate === "object",
      `exit ${json.exitCode} · ${doc ? `ok ${String(doc.ok)} · recommended ${recommended.slice(0, 80)}` : "no JSON"}`,
    ),
    check(
      "probe reads GitHub and writes nothing",
      githubIn(sim, STEP.json).length > 0 && writes.length === 0,
      `${githubIn(sim, STEP.json).length} GitHub calls · ${writes.length} writes`,
    ),
    check(
      "probe asks no model: its only AI host call is the provider's price list",
      completions.length === 0 &&
        aiCalls.every(
          (call) => call.method === "GET" && /\/models\b/.test(call.url),
        ),
      `${completions.length} completions · ${aiCalls.map((call) => `${call.method} ${new URL(call.url).pathname}`).join(", ") || "no AI host call"}`,
    ),
    check(
      "the recommended init makes no more GitHub calls than probe estimated",
      init?.exitCode === 0 &&
        estimated > 0 &&
        githubIn(sim, STEP.init).length <= estimated,
      `estimated ${estimated} · made ${githubIn(sim, STEP.init).length} · init exit ${init?.exitCode}`,
    ),
    check(
      "probe on a repository that does not exist fails with a message that names it, not a stack",
      missing.exitCode !== 0 &&
        /sim\/nowhere/.test(missing.stdout + missing.stderr) &&
        !/\n\s+at /.test(missing.stderr),
      `exit ${missing.exitCode} · ${(missing.stderr || missing.stdout).trim().split("\n")[0]?.slice(0, 120)}`,
    ),
  ];
}

export default defineFlow({
  name: "probe",
  description:
    "probe reads a repository with pull requests and recommends init, in human and JSON output, with no AI call and no GitHub write",
  // init's own answers. Which guide jobs run depends on what init reads, so
  // none of them has to.
  ai: INIT_SYNC_AI.map((rule) => ({ ...rule, optional: true })),
  steps: [
    {
      name: STEP.repo,
      run(sim) {
        sim.repo(SAMPLE_REPO_NAME, SAMPLE_REPO);
        for (const title of ["Add divide", "Add average", "Round percent"]) {
          const pull = sim.github.openPull(SAMPLE_REPO_NAME, {
            title,
            files: {
              [`src/${title.toLowerCase().replace(/ /g, "_")}.ts`]: `export const x = 1\n`,
            },
          });
          sim.github.merge(pull);
        }
        return `${SAMPLE_REPO_NAME} · 3 merged pull requests`;
      },
    },
    {
      name: STEP.human,
      async run(sim) {
        sim.state.human = await sim.cli([
          "probe",
          SAMPLE_REPO_NAME,
          ...aiFlags(sim),
        ]);
        return `exit ${runAt(sim, "human").exitCode}`;
      },
    },
    {
      name: STEP.json,
      async run(sim) {
        sim.state.json = await sim.cli([
          "probe",
          SAMPLE_REPO_NAME,
          "--json",
          ...aiFlags(sim),
        ]);
        return `exit ${runAt(sim, "json").exitCode}`;
      },
    },
    {
      name: STEP.init,
      async run(sim) {
        const doc = parseJsonOutput(runAt(sim, "json").stdout) as
          | Json
          | undefined;
        const command = String(
          (doc?.recommended as Json | undefined)?.command ??
            doc?.recommended ??
            "",
        );
        const args = command.split(/\s+/).slice(1).filter(Boolean);
        if (args[0] !== "init")
          throw new Error(`no init command in ${command}`);
        sim.state.init = await sim.cli([...args, ...aiFlags(sim)]);
        return `${args.join(" ")} · exit ${runAt(sim, "init").exitCode}`;
      },
    },
    {
      name: STEP.missing,
      async run(sim) {
        sim.state.missing = await sim.cli([
          "probe",
          "sim/nowhere",
          ...aiFlags(sim),
        ]);
        return `exit ${runAt(sim, "missing").exitCode}`;
      },
    },
  ],
  checks,
});
