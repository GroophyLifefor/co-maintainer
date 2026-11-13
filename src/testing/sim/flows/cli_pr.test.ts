/** The CLI review flow's own helpers, and the flow run end to end. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AiRule } from "../fake_ai.ts";
import {
  defineFlow,
  type Flow,
  type FlowResult,
  type Printer,
  type RunSettings,
  runFlow,
} from "../flow.ts";
import cliPr, {
  CLI_PR_AI,
  cliPrAi,
  guidesStep,
  lineOf,
  mainFiles,
  openChangePull,
  parseJsonOutput,
  reviewCli,
  TITLES,
} from "./cli_pr.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("cli-pr: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(cliPr, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  // Every check that is skipped says why.
  for (const check of result.checks.filter((item) => item.skipped)) {
    assert.ok(check.skipped!.length > 20, check.name);
  }
});

test("lineOf: counts from one and refuses a missing line", () => {
  assert.equal(lineOf("a\nb\nc", "c"), 3);
  assert.throws(() => lineOf("a\nb", "z"), /no line holds z/);
});

test("parseJsonOutput: one JSON line is a document, anything else is not", () => {
  assert.deepEqual(parseJsonOutput('{"ok":true}\n'), { ok: true });
  assert.equal(parseJsonOutput('{"ok":true}\n{"ok":false}\n'), undefined);
  assert.equal(parseJsonOutput("not json\n"), undefined);
  assert.equal(parseJsonOutput(""), undefined);
});

test("cliPrAi: only the named pull requests get a review answer", () => {
  const rules = cliPrAi(TITLES.clean);
  const reviews = rules.filter((rule) => rule.job === "review_pull_request");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.prompt, `"title":${JSON.stringify(TITLES.clean)}`);
  assert.ok(rules.some((rule) => rule.job === "extract_unit"));
});

test("mainFiles: the guard changes only the math file", () => {
  const before = mainFiles();
  const after = mainFiles(true);
  assert.notEqual(before["src/math.ts"], after["src/math.ts"]);
  assert.equal(before["scripts/deploy.sh"], after["scripts/deploy.sh"]);
});

function onlyMainFlow(ai: AiRule[]): Flow {
  return defineFlow({
    name: "only-main",
    description: "opens only the standard pull request",
    ai,
    steps: [
      guidesStep,
      {
        name: "review",
        async run(sim) {
          await reviewCli(sim, openChangePull(sim).number, ["--json"]);
        },
      },
    ],
  });
}

const answered = (result: FlowResult) =>
  result.checks.find((check) => check.name === "every AI rule answered");

test("CLI_PR_AI: a flow that opens one pull request is not failed for the rest", async () => {
  const result = await runFlow(onlyMainFlow(CLI_PR_AI), settings(), quiet);
  assert.equal(answered(result)?.ok, true, JSON.stringify(answered(result)));
  assert.equal(result.passed, true);
});

test("cliPrAi: a title a flow names and never opens is reported", async () => {
  const exact = await runFlow(
    onlyMainFlow(cliPrAi(TITLES.main)),
    settings(),
    quiet,
  );
  assert.equal(exact.passed, true);
  const unused = await runFlow(
    onlyMainFlow(cliPrAi(TITLES.main, TITLES.clean)),
    settings(),
    quiet,
  );
  assert.equal(answered(unused)?.ok, false);
});
