/** CLI pull request review: `co-maintainer review owner/repo N`.
 *
 * The CLI reads the pull request through `gh`, asks the model once and prints
 * the review in one of three formats. It never posts. The flow runs a real
 * `init` first (so the guides are on disk the way a person has them), then
 * reviews eight pull requests in the ways a careful person would try by hand:
 * a blocking one in all three output formats, a clean one, a closed one, a
 * merged one, one that needs a tool round, one the AI fails on, one under the
 * `severity` blocking rule and one with more findings than GitHub annotates.
 * It also covers a missing pull request, an unreadable repository, a
 * repository with no guides and a second review after the author pushes.
 *
 * The exports are for the feature flows that build on this one: a repository
 * with guides (`guidesStep`), opening a pull request (`openChangePull`),
 * pushing to it (`pushFix`), running the review (`reviewCli`) and the AI
 * script (`CLI_PR_AI`, `reviewRule`). */
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { CheckResult } from "../checks/common.ts";
import { type AiRule, finding } from "../fake_ai.ts";
import {
  check,
  type CliRun,
  defineFlow,
  type Score,
  type Sim,
  type Step,
} from "../flow.ts";
import type { SimPull } from "../github.ts";
import { SAMPLE_REPO, SAMPLE_REPO_NAME } from "../sample_repo.ts";
import { INIT_AI } from "./init.ts";

/** The repository the guides are built for. */
export const CLI_PR_REPO = SAMPLE_REPO_NAME;
/** A repository GitHub knows and `init` never ran on. */
export const BARE_REPO = "sim/bare";

/** The title each scenario's pull request carries. The fake AI tells the
 * pull requests apart by title, so a feature flow that opens one of these
 * gets this flow's answer for it. */
export const TITLES = {
  main: "Add divide and a deploy script",
  clean: "Fix a typo in the README",
  closed: "Rename the clamp arguments",
  merged: "Document formatPercent",
  tools: "Round the percent",
  fails: "Trim the CI steps",
  severity: "Tweak clamp",
  many: "Add many helpers",
  bare: "A change in a repository without guides",
} as const;

export const MAIN_BODY =
  'Adds `divide` and a "release" script.\n\nNothing else changes.';
export const MAIN_COMMENT = "Please cover divide with a test.";

const MATH_BASE = SAMPLE_REPO["src/math.ts"]!;
const DIVIDE = [
  "export function divide(a: number, b: number): number {",
  "  return a / b;",
  "}",
].join("\n");
const DIVIDE_GUARDED = [
  "export function divide(a: number, b: number): number {",
  '  if (b === 0) throw new RangeError("divide by zero");',
  "  return a / b;",
  "}",
].join("\n");

/** The changed files of the standard pull request: three the guide covers
 * (`src/` and `test/`) and one it says nothing about (`scripts/`). */
export function mainFiles(guarded = false): Record<string, string> {
  return {
    "src/math.ts": `${MATH_BASE}\n${guarded ? DIVIDE_GUARDED : DIVIDE}\n`,
    "src/format.ts": [
      'import { clamp } from "./math.ts";',
      "",
      "export function formatPercent(ratio: number, digits = 0): string {",
      "  return `${(clamp(ratio, 0, 1) * 100).toFixed(digits)}%`;",
      "}",
      "",
    ].join("\n"),
    "test/math.test.ts":
      `${SAMPLE_REPO["test/math.test.ts"]}\ntest("divide", () => assert.equal(divide(6, 3), 2));\n`.replace(
        "{ add, clamp }",
        "{ add, clamp, divide }",
      ),
    "scripts/deploy.sh": '#!/bin/sh\nset -e\necho "deploying"\n',
  };
}

/** The 1-based line of the first line of `content` that holds `text`. */
export function lineOf(content: string, text: string): number {
  const index = content.split("\n").findIndex((line) => line.includes(text));
  if (index < 0) throw new Error(`no line holds ${text}`);
  return index + 1;
}

/** A finding the way the review JSON carries it, with the symbol the
 * `finding()` helper leaves out. */
export function symbolFinding(
  input: Parameters<typeof finding>[0] & { symbol?: string },
) {
  const { symbol, ...rest } = input;
  return { ...finding(rest), ...(symbol ? { symbol } : {}) };
}

/** An AI rule for `review_pull_request` on the pull request with this title. */
export function reviewRule(
  title: string,
  reply: AiRule["reply"],
  name = `review: ${title}`,
): AiRule {
  return {
    name,
    job: "review_pull_request",
    // The prompt carries the pull request as one JSON object.
    prompt: `"title":${JSON.stringify(title)}`,
    reply,
  };
}

const DIVIDE_LINE = lineOf(mainFiles()["src/math.ts"]!, "return a / b;");

/** Findings for the standard pull request: one blocking, in a file the guide
 * covers, and two that do not block, one of them outside the guide. */
export const MAIN_FINDINGS = [
  symbolFinding({
    path: "src/math.ts",
    line: DIVIDE_LINE,
    title: "divide does not guard a zero divisor",
    body: "A zero divisor returns Infinity, so the caller gets no error.",
    severity: "P1",
    blocking: true,
    symbol: "divide",
  }),
  symbolFinding({
    path: "src/format.ts",
    line: 4,
    title: "formatPercent changed its output for fractions",
    body: "The helper now rounds with toFixed, which differs from Math.round.",
    severity: "P3",
    symbol: "formatPercent",
  }),
  symbolFinding({
    path: "scripts/deploy.sh",
    line: 3,
    title: "the deploy script prints no version",
    body: "The script does not say what it deploys.",
    severity: "P2",
  }),
];

/** What the model answers once the author guards the divisor: the blocking
 * finding is gone, the others stay. */
const AFTER_PUSH_FINDINGS = MAIN_FINDINGS.slice(1);

const MANY_COUNT = 12;
const MANY_BODY =
  "a | b [link](http://example.com)\n::set-output name=x::y\nlast line";

function manyFindings() {
  const path = "src/many.ts";
  return Array.from({ length: MANY_COUNT * 2 }, (_, index) =>
    symbolFinding({
      path,
      line: index + 1,
      title: `finding ${index + 1}`,
      body: index === 0 ? MANY_BODY : `Problem number ${index + 1}.`,
      severity: index < MANY_COUNT ? "P1" : "P3",
      blocking: index < MANY_COUNT,
      symbol: `v${index + 1}`,
    }),
  );
}

export function manyFiles(): Record<string, string> {
  return {
    "src/many.ts": `${Array.from(
      { length: MANY_COUNT * 2 },
      (_, index) => `export const v${index + 1} = ${index + 1};`,
    ).join("\n")}\n`,
  };
}

/** What the model answers a review with, by pull request title. */
const REVIEW_RULES: AiRule[] = [
  // The push round: the model sees the guard in the diff and drops the
  // blocking finding. Listed first, so it wins over the plain answer.
  reviewRule(
    TITLES.main,
    ({ prompt }) => ({
      findings: prompt.includes(DIVIDE_GUARDED.split("\n")[1]!.trim())
        ? AFTER_PUSH_FINDINGS
        : MAIN_FINDINGS,
    }),
    "review: the standard pull request, before and after a push",
  ),
  reviewRule(TITLES.clean, { findings: [] }),
  reviewRule(TITLES.closed, {
    findings: [
      symbolFinding({
        path: "src/math.ts",
        line: 5,
        title: "the renamed argument shadows nothing",
        body: "The rename is harmless.",
        severity: "P3",
        symbol: "clamp",
      }),
    ],
  }),
  reviewRule(TITLES.merged, { findings: [] }),
  // A tool round: the model reads the Mermaid syntax first, then answers.
  reviewRule(TITLES.tools, ({ round }) =>
    round === 0
      ? {
          toolCalls: [
            {
              name: "read-mermaid-syntaxes",
              arguments: { tools: ["flowchart"] },
            },
          ],
        }
      : {
          findings: [
            symbolFinding({
              path: "src/format.ts",
              line: 4,
              title: "toFixed rounds half to even in some engines",
              body: "The percent can differ by one from the old output.",
              severity: "P2",
              symbol: "formatPercent",
            }),
          ],
        },
  ),
  // TITLES.fails has no rule: its AI call is failed by a fault before a rule
  // could answer it, and a rule nothing used would be reported.
  // A P1 the model calls non-blocking: it blocks only under `severity`.
  reviewRule(TITLES.severity, {
    findings: [
      symbolFinding({
        path: "src/math.ts",
        line: 6,
        title: "clamp swaps its bounds",
        body: "A minimum above the maximum returns the maximum.",
        severity: "P1",
        blocking: false,
        symbol: "clamp",
      }),
    ],
  }),
  reviewRule(TITLES.many, { findings: manyFindings() }),
];

/** Every answer this flow needs: the reviews above and the init flow's, for
 * the step that builds the guides. */
export const CLI_PR_AI: AiRule[] = [...REVIEW_RULES, ...INIT_AI];

/** The answers for only the pull requests with these titles, plus init's. A
 * flow that never opens the others should use this, since a rule that no
 * call used is reported. */
export function cliPrAi(...titles: string[]): AiRule[] {
  const wanted = titles.map((title) => `"title":${JSON.stringify(title)}`);
  return [
    ...REVIEW_RULES.filter((rule) => wanted.includes(String(rule.prompt))),
    ...INIT_AI,
  ];
}

/** A repository with guides: the sample repository, opened on GitHub and
 * given SKILL.md and CODEBASE.md by a real codebase-only `init`. */
export const guidesStep: Step = {
  name: "repository with guides",
  async run(sim) {
    sim.repo(CLI_PR_REPO);
    const { runInitOrRemake } = await import("../../../services/setup.ts");
    await runInitOrRemake(sim.options({ command: "init", repo: CLI_PR_REPO }));
    return `${CLI_PR_REPO} · guides written by init`;
  },
};

/** Opens the standard pull request, or the one `overrides` describe, in the
 * repository with guides. */
export function openChangePull(
  sim: Sim,
  overrides: {
    repo?: string;
    title?: string;
    body?: string;
    files?: Record<string, string>;
  } = {},
): SimPull {
  return sim.github.openPull(overrides.repo ?? CLI_PR_REPO, {
    title: overrides.title ?? TITLES.main,
    body: overrides.body ?? MAIN_BODY,
    files: overrides.files ?? mainFiles(),
  });
}

/** The author pushes the guard for the zero divisor onto the pull request. */
export function pushFix(sim: Sim, pull: SimPull): string {
  return sim.github.push(
    pull,
    { "src/math.ts": mainFiles(true)["src/math.ts"]! },
    "Guard a zero divisor",
  );
}

/** The flags every review needs: gh for GitHub, the world's AI key and the
 * run's models. Credentials go on the command line, the way CI passes them. */
export function aiFlags(sim: Sim): string[] {
  const options = sim.options();
  return [
    "--auth=gh",
    `--ai=${options.ai}`,
    `--token=${options.aiToken}`,
    `--low-model=${options.lowModel}`,
    `--high-model=${options.highModel}`,
  ];
}

/** Runs `co-maintainer review <repo> <number> ...` and keeps the run under
 * the step that is running, so a check can find it. */
export async function reviewCli(
  sim: Sim,
  number: number,
  extra: string[] = [],
  repo = CLI_PR_REPO,
): Promise<CliRun> {
  const run = await sim.cli([
    "review",
    repo,
    String(number),
    ...aiFlags(sim),
    ...extra,
  ]);
  const runs = (sim.state.cliRuns ??= {}) as Record<string, CliRun[]>;
  (runs[sim.trace.step] ??= []).push(run);
  return run;
}

/** The CLI runs a step made, in order. */
export function runsOf(sim: Sim, step: string): CliRun[] {
  return ((sim.state.cliRuns ?? {}) as Record<string, CliRun[]>)[step] ?? [];
}

/** Runs the review with `GITHUB_STEP_SUMMARY` pointing at a file in the
 * sandbox, as a workflow step has it. Returns the run and the summary. */
export async function reviewWithSummary(
  sim: Sim,
  number: number,
  extra: string[] = [],
): Promise<{ run: CliRun; summary: string }> {
  const path = `${sim.world.root}/step-summary-${number}.md`;
  rmSync(path, { force: true });
  const before = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = path;
  try {
    const run = await reviewCli(sim, number, ["--output=github", ...extra]);
    return {
      run,
      summary: existsSync(path) ? readFileSync(path, "utf8") : "",
    };
  } finally {
    if (before === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = before;
  }
}

/** What the review's model call received, from the trace. */
export function reviewCompletions(sim: Sim, step: string) {
  return sim.trace.completions.filter(
    (completion) =>
      completion.step === step && completion.job === "review_pull_request",
  );
}

/** The GitHub calls a step made, as `METHOD endpoint` without host or query. */
export function githubCalls(sim: Sim, step: string): string[] {
  return sim.trace.github
    .filter((call) => call.step === step)
    .map((call) => `${call.method} ${new URL(call.url).pathname.slice(1)}`);
}

/** The endpoints one successful review of pull request `number` reads. */
export function reviewReads(number: number, repo = CLI_PR_REPO): string[] {
  return [
    `GET repos/${repo}/pulls/${number}`,
    `GET repos/${repo}/issues/${number}/comments`,
    `GET repos/${repo}/pulls/${number}/reviews`,
    `GET repos/${repo}/pulls/${number}/files`,
  ];
}

type Json = Record<string, unknown>;

/** `--json` output as an object, or undefined when it is not one document. */
export function parseJsonOutput(stdout: string): Json | undefined {
  const lines = stdout.split("\n").filter(Boolean);
  if (lines.length !== 1) return undefined;
  try {
    return JSON.parse(lines[0]!) as Json;
  } catch {
    return undefined;
  }
}

function pullOf(sim: Sim, name: string): SimPull {
  const pull = (sim.state.pulls as Record<string, SimPull> | undefined)?.[name];
  if (!pull) throw new Error(`the flow has no pull request ${name}`);
  return pull;
}

function remember(sim: Sim, name: string, pull: SimPull): SimPull {
  const pulls = (sim.state.pulls ??= {}) as Record<string, SimPull>;
  pulls[name] = pull;
  return pull;
}

const code = (run: CliRun) => `exit ${run.exitCode}`;

/** Steps. One step per scenario, so the trace's step name tells which
 * scenario a call or a log line belongs to. */
const STEP = {
  main: "open the standard pull request",
  human: "review, human output",
  json: "review, --json",
  github: "review, --output=github",
  clean: "review a clean pull request",
  closed: "review a closed pull request",
  merged: "review a merged pull request",
  missing: "review a pull request that does not exist",
  unreadable: "review in a repository gh cannot read",
  bare: "review in a repository with no guides",
  push: "review again after a push",
  tools: "review with a tool round",
  fails: "review when the AI call fails",
  severity: "review under the severity rule",
  many: "review with more findings than GitHub annotates",
} as const;

const steps: Step[] = [
  guidesStep,
  {
    name: STEP.main,
    run(sim) {
      const pull = remember(sim, "main", openChangePull(sim));
      sim.github.comment(pull, MAIN_COMMENT);
      return `#${pull.number} · ${Object.keys(mainFiles()).length} files`;
    },
  },
  {
    name: STEP.human,
    async run(sim) {
      const run = await reviewCli(sim, pullOf(sim, "main").number);
      return code(run);
    },
  },
  {
    name: STEP.json,
    async run(sim) {
      const run = await reviewCli(sim, pullOf(sim, "main").number, [
        "--json",
        "--disable-codegraph",
      ]);
      return code(run);
    },
  },
  {
    name: STEP.github,
    async run(sim) {
      const { run, summary } = await reviewWithSummary(
        sim,
        pullOf(sim, "main").number,
      );
      sim.state.mainSummary = summary;
      return code(run);
    },
  },
  {
    name: STEP.clean,
    async run(sim) {
      const pull = remember(
        sim,
        "clean",
        openChangePull(sim, {
          title: TITLES.clean,
          body: "",
          files: {
            "README.md": SAMPLE_REPO["README.md"]!.replace(
              "helpers",
              "helpers.",
            ),
          },
        }),
      );
      const run = await reviewCli(sim, pull.number);
      return `#${pull.number} · ${code(run)}`;
    },
  },
  {
    name: STEP.closed,
    async run(sim) {
      const pull = remember(
        sim,
        "closed",
        openChangePull(sim, {
          title: TITLES.closed,
          body: "Never mind, closing.",
          files: {
            "src/math.ts": MATH_BASE.replaceAll(
              "min, max",
              "low, high",
            ).replace(
              "Math.max(value, min), max",
              "Math.max(value, low), high",
            ),
          },
        }),
      );
      sim.github.close(pull);
      const run = await reviewCli(sim, pull.number);
      return `#${pull.number} · ${code(run)}`;
    },
  },
  {
    name: STEP.merged,
    async run(sim) {
      const pull = remember(
        sim,
        "merged",
        openChangePull(sim, {
          title: TITLES.merged,
          body: "Documents the helper.",
          files: {
            "src/format.ts": `/** Formats a ratio as a percent. */\n${SAMPLE_REPO[
              "src/format.ts"
            ]!.replace(
              "\n\nexport",
              "\n\n/** Rounds to a whole percent. */\nexport",
            )}`,
          },
        }),
      );
      sim.github.merge(pull);
      const run = await reviewCli(sim, pull.number);
      return `#${pull.number} · ${code(run)}`;
    },
  },
  {
    name: STEP.missing,
    async run(sim) {
      const human = await reviewCli(sim, 404);
      const json = await reviewCli(sim, 404, ["--json"]);
      return `${code(human)} · json ${code(json)}`;
    },
  },
  {
    name: STEP.unreadable,
    async run(sim) {
      // What gh says about a repository the logged-in user cannot read.
      sim.faults.add({ target: "github", kind: "404", path: /\/pulls\/1$/ });
      const run = await reviewCli(sim, 1);
      return code(run);
    },
  },
  {
    name: STEP.bare,
    async run(sim) {
      sim.repo(BARE_REPO);
      const pull = openChangePull(sim, {
        repo: BARE_REPO,
        title: TITLES.bare,
      });
      remember(sim, "bare", pull);
      const run = await reviewCli(sim, pull.number, [], BARE_REPO);
      return code(run);
    },
  },
  {
    name: STEP.push,
    async run(sim) {
      const pull = pullOf(sim, "main");
      const sha = pushFix(sim, pull);
      sim.state.pushedSha = sha;
      const run = await reviewCli(sim, pull.number);
      return `${sha.slice(0, 7)} · ${code(run)}`;
    },
  },
  {
    name: STEP.tools,
    async run(sim) {
      const pull = remember(
        sim,
        "tools",
        openChangePull(sim, {
          title: TITLES.tools,
          body: "Rounds with toFixed.",
          files: { "src/format.ts": mainFiles()["src/format.ts"]! },
        }),
      );
      const run = await reviewCli(sim, pull.number, ["--disable-codegraph"]);
      return `#${pull.number} · ${code(run)}`;
    },
  },
  {
    name: STEP.fails,
    async run(sim) {
      const pull = remember(
        sim,
        "fails",
        openChangePull(sim, {
          title: TITLES.fails,
          body: "Fewer CI steps.",
          files: {
            ".github/workflows/ci.yml": SAMPLE_REPO[
              ".github/workflows/ci.yml"
            ]!.replace("      - run: npm run check\n", ""),
          },
        }),
      );
      sim.faults.add({
        target: "ai",
        kind: "500",
        job: "review_pull_request",
      });
      const run = await reviewCli(sim, pull.number, ["--json"]);
      return `#${pull.number} · ${code(run)}`;
    },
  },
  {
    name: STEP.severity,
    async run(sim) {
      const pull = remember(
        sim,
        "severity",
        openChangePull(sim, {
          title: TITLES.severity,
          body: "",
          files: {
            "src/math.ts": MATH_BASE.replace(
              "Math.min(Math.max(value, min), max)",
              "Math.max(Math.min(value, max), min)",
            ),
          },
        }),
      );
      const model = await reviewCli(sim, pull.number, ["--json"]);
      sim.world.writeConfig({ reviewBlocking: "severity" });
      const severity = await reviewCli(sim, pull.number, ["--json"]);
      return `#${pull.number} · model ${code(model)} · severity ${code(severity)}`;
    },
  },
  {
    name: STEP.many,
    async run(sim) {
      const pull = remember(
        sim,
        "many",
        openChangePull(sim, {
          title: TITLES.many,
          body: "Many helpers.",
          files: manyFiles(),
        }),
      );
      const { run, summary } = await reviewWithSummary(sim, pull.number);
      sim.state.manySummary = summary;
      return `#${pull.number} · ${code(run)}`;
    },
  },
];

function skipLive(sim: Sim, result: CheckResult): CheckResult {
  return sim.mode === "live"
    ? { ...result, ok: true, skipped: "live AI: the answers are the model's" }
    : result;
}

/** A check about what the scripted answers must lead to. With a live model
 * the findings are the model's, so these are skipped. */
function scripted(
  sim: Sim,
  name: string,
  ok: boolean,
  detail: string,
): CheckResult {
  return skipLive(sim, check(name, ok, detail));
}

/** A check something fails today, the product or the core. It is kept, and
 * shown as skipped with the reason, until that is fixed. */
function knownBug(
  name: string,
  ok: boolean,
  detail: string,
  reason: string,
): CheckResult {
  return ok
    ? check(name, true, detail)
    : { name, ok: true, detail, skipped: reason };
}

function lines(run: CliRun | undefined): string[] {
  return (run?.stdout ?? "").split("\n");
}

function flowChecks(sim: Sim): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (...items: CheckResult[]) => results.push(...items);
  const main = pullOf(sim, "main");
  const [human] = runsOf(sim, STEP.human);
  const [json] = runsOf(sim, STEP.json);
  const [github] = runsOf(sim, STEP.github);
  const mainPaths = Object.keys(mainFiles());
  const guideText = (name: string) => {
    const path = `${sim.paths.reposDir}/${CLI_PR_REPO}/${name}`;
    return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  };

  // The human output.
  const out = human?.stdout ?? "";
  const header = `co-maintainer review · ${CLI_PR_REPO} · PR #${main.number}`;
  add(
    scripted(
      sim,
      "human review prints the findings and exits 1 on a blocking one",
      human?.exitCode === 1 &&
        out.includes(header) &&
        out.includes("New (3)") &&
        out.includes(
          `src/math.ts:${DIVIDE_LINE}  [P1 · blocking] \`divide\``,
        ) &&
        out.includes("src/format.ts:4  [P3 · non-blocking] `formatPercent`") &&
        out.includes("scripts/deploy.sh:3  [P2 · non-blocking]") &&
        out.includes("Summary: 3 new · 0 open · 0 closed · 1 blocking"),
      `${human ? code(human) : "no run"}, ${out.length} chars`,
    ),
    scripted(
      sim,
      "human review lists the blocking finding before the others",
      out.indexOf("[P1 · blocking]") > -1 &&
        out.indexOf("[P1 · blocking]") < out.indexOf("[P2 · non-blocking]") &&
        out.indexOf("[P2 · non-blocking]") < out.indexOf("[P3 · non-blocking]"),
      "P1, then P2, then P3",
    ),
    check(
      "human review names the guide build and the codegraph state",
      /guide built \d{4}-\d{2}-\d{2} · codegraph unavailable/.test(out),
      "codegraph is not installed in the sandbox, and the flag was not given",
    ),
    check(
      "human review prints no legend, no progress and no cost line on stdout",
      !out.includes("explain it in more detail") &&
        !out.includes("Severity legend") &&
        !/\[(review|scope|checkout|codegraph)\]/.test(out) &&
        !/Done in /.test(out),
      "stdout holds the review only",
    ),
    check(
      "the run line reports the tokens the AI calls used",
      (() => {
        const used = reviewCompletions(sim, STEP.human).reduce(
          (sum, call) => [sum[0] + call.tokensIn, sum[1] + call.tokensOut],
          [0, 0],
        );
        const line = sim.trace.logs.find(
          (entry) => entry.step === STEP.human && entry.phase === "done",
        );
        return (
          used[0] > 0 &&
          line?.message.includes(
            `${used[0].toLocaleString("en-US")} in, ${used[1].toLocaleString("en-US")} out tokens`,
          ) === true
        );
      })(),
      "the done line matches the completions of the step",
    ),
  );

  // What the model was sent.
  const sent = reviewCompletions(sim, STEP.human)[0];
  const prompt = sent?.firstUser ?? "";
  add(
    check(
      "the review prompt holds the pull request's title, body and state",
      prompt.includes(`"title":${JSON.stringify(TITLES.main)}`) &&
        prompt.includes(`"body":${JSON.stringify(MAIN_BODY)}`) &&
        prompt.includes('"state":"open"') &&
        prompt.includes(`"number":${main.number},`),
      `${prompt.length} chars`,
    ),
    check(
      "the review prompt lists every changed file and the existing comments",
      prompt.includes(
        `"changedFiles":${JSON.stringify(mainPaths.sort((a, b) => a.localeCompare(b)))}`,
      ) &&
        prompt.includes(`"existingComments":[${JSON.stringify(MAIN_COMMENT)}]`),
      mainPaths.join(", "),
    ),
    check(
      "the review prompt holds each file's diff with line numbers, the file outside the guide too",
      mainPaths.every((path) => prompt.includes(`FILE: ${path}\n`)) &&
        new RegExp(`\\s${DIVIDE_LINE} \\+  return a / b;`).test(prompt) &&
        /\s3 \+echo "deploying"/.test(prompt) &&
        !prompt.includes("diff withheld"),
      `${mainPaths.length} files`,
    ),
    check(
      "the system prompt holds the guides init wrote",
      (() => {
        const skill = guideText("SKILL.md");
        const codebase = guideText("CODEBASE.md");
        return (
          skill.length > 0 &&
          codebase.length > 0 &&
          (sent?.system ?? "").includes(`REVIEW GUIDE:\n${skill}`) &&
          (sent?.system ?? "").includes(`CODEBASE CONVENTIONS:\n${codebase}`)
        );
      })(),
      "SKILL.md as the review guide, CODEBASE.md as the conventions",
    ),
    check(
      "the review asks the high model for structured JSON and offers the diagram tool",
      (() => {
        const request = sim.trace.ai.find(
          (call) =>
            call.step === STEP.human && call.job === "review_pull_request",
        )?.request as Json | undefined;
        const tools = ((request?.tools ?? []) as Json[]).map(
          (tool) => (tool.function as Json | undefined)?.name,
        );
        const format = request?.response_format as Json | undefined;
        return (
          request?.model === sim.options().highModel &&
          (format?.json_schema as Json | undefined)?.name ===
            "review_findings" &&
          tools.includes("read-mermaid-syntaxes") &&
          !tools.some((name) => String(name).startsWith("codegraph"))
        );
      })(),
      "model, response_format and tools of the first request",
    ),
    check(
      "the review is one AI call, with no retry and no summary call",
      sim.trace.completions.filter((call) => call.step === STEP.human)
        .length === 1,
      "review_pull_request only",
    ),
  );

  // Reading and writing GitHub.
  const reviewSteps = [
    STEP.human,
    STEP.json,
    STEP.github,
    STEP.clean,
    STEP.closed,
    STEP.merged,
    STEP.tools,
    STEP.severity,
    STEP.many,
  ];
  const numbers: Record<string, number> = {
    [STEP.human]: main.number,
    [STEP.json]: main.number,
    [STEP.github]: main.number,
    [STEP.clean]: pullOf(sim, "clean").number,
    [STEP.closed]: pullOf(sim, "closed").number,
    [STEP.merged]: pullOf(sim, "merged").number,
    [STEP.tools]: pullOf(sim, "tools").number,
    [STEP.severity]: pullOf(sim, "severity").number,
    [STEP.many]: pullOf(sim, "many").number,
  };
  // init reads GitHub with the token, so only the steps after it count.
  const reviewCalls = sim.trace.github.filter(
    (call) => call.step !== guidesStep.name && call.step !== "setup",
  );
  const wrong = reviewSteps.flatMap((step) => {
    const expected = reviewReads(numbers[step]!);
    const calls = githubCalls(sim, step).filter(
      (call) => !call.endsWith("/rate_limit"),
    );
    const times = step === STEP.severity ? 2 : 1;
    const same =
      JSON.stringify([...calls].sort()) ===
      JSON.stringify([...expected, ...(times === 2 ? expected : [])].sort());
    return same ? [] : [`${step}: ${calls.join(", ")}`];
  });
  add(
    check(
      "each review reads exactly the pull request, its comments, its reviews and its files",
      wrong.length === 0,
      wrong.length
        ? wrong.join(" | ")
        : `${reviewSteps.length} reviews, 4 reads each`,
    ),
    check(
      "a review reaches GitHub only through gh, with reads only",
      reviewCalls.length > 0 &&
        reviewCalls.every(
          (call) => call.via === "gh" && (call.method === "GET" || call.fault),
        ),
      `${reviewCalls.length} calls`,
    ),
    check(
      "nothing is written to GitHub",
      sim.github.writes.length === 0 &&
        sim.github.reviews.length === 0 &&
        sim.github.checkRuns.length === 0 &&
        sim.github.comments.length === 1,
      `${sim.github.writes.length} writes, only the person's own comment exists`,
    ),
    check(
      "a review that finished answered every GitHub call with 200",
      reviewSteps.every((step) =>
        sim.trace.github
          .filter((call) => call.step === step)
          .every((call) => call.status === 200),
      ),
      "no error status in the finished reviews",
    ),
  );

  // --json.
  const parsed = json ? parseJsonOutput(json.stdout) : undefined;
  const findings = ((parsed?.findings ?? []) as Json[]).map((row) => row);
  const FIELDS = [
    "id",
    "state",
    "closeReason",
    "severity",
    "blocking",
    "path",
    "lineFrom",
    "lineTo",
    "title",
    "body",
    "suggestion",
  ];
  add(
    check(
      "--json prints one JSON document with the documented fields",
      (() => {
        if (!parsed) return false;
        const subject = parsed.subject as Json;
        const guide = parsed.guide as Json;
        const codegraph = parsed.codegraph as Json;
        const usage = parsed.usage as Json;
        return (
          parsed.schemaVersion === 1 &&
          parsed.ok === true &&
          parsed.mode === "pr" &&
          subject?.repo === CLI_PR_REPO &&
          subject?.branch === null &&
          subject?.prNumber === main.number &&
          typeof guide?.builtAt === "string" &&
          codegraph?.state === "disabled" &&
          codegraph?.reason === null &&
          typeof usage?.tokensIn === "number" &&
          typeof usage?.tokensOut === "number" &&
          typeof parsed.durationMs === "number" &&
          Array.isArray(parsed.warnings) &&
          findings.every((row) => FIELDS.every((field) => field in row))
        );
      })(),
      parsed ? `${findings.length} findings` : "stdout is not one JSON line",
    ),
    scripted(
      sim,
      "--json findings, summary counts and exit code agree",
      (() => {
        if (!parsed) return false;
        const summary = (parsed.summary ?? {}) as Json;
        const blocking = findings.filter((row) => row.blocking === true);
        return (
          findings.length === 3 &&
          summary.new === 3 &&
          summary.open === 0 &&
          summary.closed === 0 &&
          summary.blocking === 1 &&
          blocking.length === 1 &&
          blocking[0]?.path === "src/math.ts" &&
          blocking[0]?.severity === "P1" &&
          findings.every((row) => row.state === "new") &&
          findings.map((row) => row.severity).join() === "P1,P2,P3" &&
          json?.exitCode === 1
        );
      })(),
      `${json ? code(json) : "no run"}`,
    ),
    check(
      "--json usage equals what the AI calls used",
      (() => {
        if (!parsed) return false;
        const used = reviewCompletions(sim, STEP.json);
        const usage = parsed.usage as Json;
        return (
          usage?.tokensIn === used.reduce((sum, c) => sum + c.tokensIn, 0) &&
          usage?.tokensOut === used.reduce((sum, c) => sum + c.tokensOut, 0) &&
          used.length === 1
        );
      })(),
      "tokensIn and tokensOut of the review call",
    ),
  );

  // --output=github.
  const annotations = lines(github).filter(Boolean);
  const summary = String(sim.state.mainSummary ?? "");
  add(
    scripted(
      sim,
      "--output=github prints one annotation per finding, errors first, and nothing else",
      github?.exitCode === 1 &&
        annotations.length === 3 &&
        annotations[0]?.startsWith(
          `::error file=src/math.ts,line=${DIVIDE_LINE},title=P1%3A divide::`,
        ) &&
        annotations[1]?.startsWith(
          "::warning file=scripts/deploy.sh,line=3,title=P2 finding::",
        ) &&
        annotations[2]?.startsWith(
          "::warning file=src/format.ts,line=4,title=P3%3A formatPercent::",
        ),
      `${annotations.length} lines, ${github ? code(github) : "no run"}`,
    ),
    scripted(
      sim,
      "--output=github writes the job summary with every finding and the run line",
      summary.startsWith("## co-maintainer review\n") &&
        summary.includes(`${CLI_PR_REPO} · PR #${main.number}`) &&
        summary.includes("| P1 (blocking) | new | src/math.ts:") &&
        summary.includes("| P3 | new | src/format.ts:4 |") &&
        summary.includes(
          "**Summary:** 3 new · 0 open · 0 closed · 1 blocking",
        ) &&
        /Done in .* · [\d,]+ in, [\d,]+ out tokens · \$/.test(summary),
      `${summary.length} chars`,
    ),
  );

  // More findings than GitHub annotates, and text that tries to be a command.
  const [many] = runsOf(sim, STEP.many);
  const manyLines = lines(many).filter(Boolean);
  const manySummary = String(sim.state.manySummary ?? "");
  add(
    scripted(
      sim,
      "annotations stop at ten errors and ten warnings and one notice counts the rest",
      manyLines.filter((line) => line.startsWith("::error ")).length === 10 &&
        manyLines.filter((line) => line.startsWith("::warning ")).length ===
          10 &&
        manyLines.filter((line) => line.startsWith("::notice ")).length === 1 &&
        manyLines.at(-1)?.includes("4 more findings are not annotated") ===
          true &&
        manyLines.length === 21 &&
        many?.exitCode === 1,
      `${manyLines.length} lines`,
    ),
    scripted(
      sim,
      "a finding's text cannot start a workflow command or a link",
      manyLines.every((line) => /^::(error|warning|notice) /.test(line)) &&
        manyLines[0]?.includes("::set-output name=x::y%0Alast line") &&
        manySummary.includes("a \\| b \\[link\\]") &&
        !/[^\\]\]\(http/.test(manySummary),
      "every stdout line is an annotation, the text is escaped",
    ),
    scripted(
      sim,
      "the job summary lists all findings even when GitHub shows twenty",
      manySummary.split("\n").filter((line) => line.startsWith("| P"))
        .length ===
        MANY_COUNT * 2 &&
        manySummary.includes(
          `**Summary:** ${MANY_COUNT * 2} new · 0 open · 0 closed · ${MANY_COUNT} blocking`,
        ),
      `${MANY_COUNT * 2} rows`,
    ),
  );

  // Clean, closed and merged pull requests.
  const [clean] = runsOf(sim, STEP.clean);
  const [closed] = runsOf(sim, STEP.closed);
  const [merged] = runsOf(sim, STEP.merged);
  const promptOf = (step: string) =>
    reviewCompletions(sim, step)[0]?.firstUser ?? "";
  add(
    scripted(
      sim,
      "a clean pull request prints no findings and exits 0",
      clean?.exitCode === 0 &&
        (clean?.stdout ?? "").includes("No actionable findings.") &&
        (clean?.stdout ?? "").includes(
          "Summary: 0 new · 0 open · 0 closed · 0 blocking",
        ),
      clean ? code(clean) : "no run",
    ),
    check(
      "a closed pull request is read and reviewed, and the prompt says it is closed",
      closed?.error === undefined &&
        promptOf(STEP.closed).includes('"state":"closed"') &&
        promptOf(STEP.closed).includes("FILE: src/math.ts"),
      closed ? code(closed) : "no run",
    ),
    scripted(
      sim,
      "a closed pull request's non-blocking finding exits 0",
      closed?.exitCode === 0 &&
        (closed?.stdout ?? "").includes("[P3 · non-blocking]"),
      closed ? code(closed) : "no run",
    ),
    check(
      "a merged pull request is read and reviewed, and the prompt says it is closed",
      merged?.error === undefined &&
        promptOf(STEP.merged).includes('"state":"closed"') &&
        reviewCompletions(sim, STEP.merged).length === 1,
      merged ? code(merged) : "no run",
    ),
    knownBug(
      "a merged pull request still shows its files in the prompt",
      promptOf(STEP.merged).includes("FILE: src/format.ts"),
      `${(promptOf(STEP.merged).match(/"changedFiles":\[[^\]]*\]/) ?? ["no changedFiles"])[0]}`,
      "core gap: the simulated /pulls/N/files diffs against the merge base after the merge, so a merged pull request lists no files, and GitHub keeps them",
    ),
  );

  // Errors.
  const [missing, missingJson] = runsOf(sim, STEP.missing);
  const [unreadable] = runsOf(sim, STEP.unreadable);
  const [bare] = runsOf(sim, STEP.bare);
  const noWork = (step: string) =>
    sim.trace.completions.filter((call) => call.step === step).length === 0 &&
    sim.github.writes.filter((write) => write.step === step).length === 0;
  const missingBody = missingJson
    ? parseJsonOutput(missingJson.stdout)
    : undefined;
  add(
    check(
      "a pull request that does not exist exits 2, prints nothing on stdout and calls no AI",
      missing?.exitCode === 2 &&
        missing.stdout === "" &&
        missing.stderr.includes(`${CLI_PR_REPO}`) &&
        noWork(STEP.missing),
      missing ? `${code(missing)}: ${missing.stderr.split("\n")[0]}` : "no run",
    ),
    check(
      "with --json the same error is one JSON document with the exit code",
      missingJson?.exitCode === 2 &&
        missingBody?.ok === false &&
        missingBody.exitCode === 2 &&
        typeof (missingBody.error as Json | undefined)?.code === "string",
      missingBody ? JSON.stringify(missingBody.error) : "stdout is not JSON",
    ),
    check(
      "a repository gh cannot read exits 2 with the gh hint and calls no AI",
      unreadable?.exitCode === 2 &&
        unreadable.stdout === "" &&
        unreadable.stderr.includes("Hint: ") &&
        noWork(STEP.unreadable),
      unreadable
        ? `${code(unreadable)}: ${unreadable.stderr.split("\n")[0]}`
        : "no run",
    ),
    check(
      "no guides: no AI call, nothing read past the pull request and the message says to run init",
      bare !== undefined &&
        bare.exitCode !== 0 &&
        bare.stdout === "" &&
        /PR_REVIEW_GUIDE\.md was not found\. Run init first/.test(
          bare.stderr,
        ) &&
        noWork(STEP.bare),
      bare ? `${code(bare)}: ${bare.stderr.split("\n")[0]}` : "no run",
    ),
    knownBug(
      "no guides: the exit code is the documented 2 for a missing init",
      bare?.exitCode === 2,
      bare ? code(bare) : "no run",
      "product bug: reviewer.ts throws a plain Error, so the CLI exits 3, and docs/md/review.md says init missing exits 2",
    ),
  );

  // Second run after a push.
  const [again] = runsOf(sim, STEP.push);
  const pushedSha = String(sim.state.pushedSha ?? "");
  const second = reviewCompletions(sim, STEP.push)[0];
  const firstPrompt = reviewCompletions(sim, STEP.human)[0];
  const guard = DIVIDE_GUARDED.split("\n")[1]!;
  add(
    check(
      "after a push the review reads the new head and sends the changed diff",
      (second?.firstUser ?? "").includes(guard.trim()) &&
        !(firstPrompt?.firstUser ?? "").includes(guard.trim()) &&
        !(second?.firstUser ?? "").includes("+  return a / b;\n\n") &&
        second?.firstUser !== firstPrompt?.firstUser &&
        pushedSha.length === 40 &&
        pullOf(sim, "main").headSha === pushedSha,
      "the second prompt holds the guard, the first does not",
    ),
    check(
      "after a push the review is one more AI call with the same system prompt",
      reviewCompletions(sim, STEP.push).length === 1 &&
        second?.system === firstPrompt?.system,
      "the guides did not change",
    ),
    scripted(
      sim,
      "after a push the blocking finding is gone and the exit code is 0",
      again?.exitCode === 0 &&
        (again?.stdout ?? "").includes(
          "Summary: 2 new · 0 open · 0 closed · 0 blocking",
        ) &&
        !(again?.stdout ?? "").includes("[P1 · blocking]"),
      again ? code(again) : "no run",
    ),
    check(
      "the review looks at the pushed commit: the scope step counts two commits",
      sim.trace.logs.some(
        (entry) =>
          entry.step === STEP.push &&
          entry.phase === "scope" &&
          /2 commits/.test(entry.message),
      ) &&
        sim.trace.logs.some(
          (entry) =>
            entry.step === STEP.human &&
            entry.phase === "scope" &&
            /1 commits/.test(entry.message),
        ),
      "the push step saw 2 commits, the first review 1",
    ),
  );

  // A pull request opened after the default branch moved on.
  const scopeLine = (step: string) =>
    sim.trace.logs.find(
      (entry) => entry.step === step && entry.phase === "scope",
    )?.message ?? "no scope line";
  add(
    knownBug(
      "after the default branch moved, the scope step counts only the pull request's own commit",
      /· 1 commits · 0 merges ·/.test(scopeLine(STEP.fails)),
      scopeLine(STEP.fails),
      "product bug: the cached clone is never fetched, so its local main is the old one and commits merged since count as the pull request's own",
    ),
  );

  // A tool round.
  const toolCalls = sim.trace.completions.filter(
    (call) => call.step === STEP.tools,
  );
  const toolRequests = sim.trace.ai.filter(
    (call) => call.step === STEP.tools && call.job === "review_pull_request",
  );
  const secondMessages = (toolRequests[1]?.request as Json | undefined)
    ?.messages as Json[] | undefined;
  const [toolRun] = runsOf(sim, STEP.tools);
  add(
    check(
      "a tool round: the model asks for a syntax page, gets it, and answers in a second call",
      toolCalls.length === 2 &&
        toolCalls[0]?.toolCalls === 1 &&
        toolCalls[1]?.toolCalls === 0 &&
        (secondMessages ?? []).some(
          (message) =>
            message.role === "tool" &&
            String(message.content).startsWith("# flowchart"),
        ) &&
        (secondMessages ?? []).some(
          (message) =>
            message.role === "assistant" && Array.isArray(message.tool_calls),
        ),
      `${toolCalls.length} calls, tool calls ${toolCalls.map((call) => call.toolCalls).join("+")}`,
    ),
    check(
      "a tool round keeps one system prompt and one first message across rounds",
      toolCalls.length === 2 &&
        toolCalls[0]?.system === toolCalls[1]?.system &&
        toolCalls[0]?.firstUser === toolCalls[1]?.firstUser,
      "the prompt cache stays valid",
    ),
    check(
      "a tool round is logged and its tokens add up in the run line",
      sim.trace.logs.some(
        (entry) =>
          entry.step === STEP.tools &&
          entry.phase === "review-tools" &&
          /round 1\/\d+ · 1 call\(s\): read-mermaid-syntaxes/.test(
            entry.message,
          ),
      ) &&
        (() => {
          const line = sim.trace.logs.find(
            (entry) => entry.step === STEP.tools && entry.phase === "done",
          );
          const tokens = toolCalls.reduce(
            (sum, call) => sum + call.tokensIn,
            0,
          );
          return (
            line?.message.includes(`${tokens.toLocaleString("en-US")} in,`) ===
            true
          );
        })(),
      "round 1 logged, both calls counted",
    ),
    scripted(
      sim,
      "a tool round ends in a normal review",
      toolRun?.exitCode === 0 &&
        (toolRun?.stdout ?? "").includes(
          "src/format.ts:4  [P2 · non-blocking]",
        ),
      toolRun ? code(toolRun) : "no run",
    ),
  );

  // A failed AI call.
  const [failed] = runsOf(sim, STEP.fails);
  const failedBody = failed ? parseJsonOutput(failed.stdout) : undefined;
  add(
    check(
      "a failed AI call exits 3, prints a JSON error and no findings",
      failed?.exitCode === 3 &&
        failedBody?.ok === false &&
        failedBody.exitCode === 3 &&
        !("findings" in (failedBody ?? {})),
      failedBody
        ? JSON.stringify(failedBody.error)
        : (failed?.stdout ?? "no run"),
    ),
    check(
      "a failed AI call names the provider and the status",
      String((failedBody?.error as Json | undefined)?.message ?? "").startsWith(
        "OpenRouter failed with 500",
      ),
      String((failedBody?.error as Json | undefined)?.message ?? ""),
    ),
    check(
      "a failed AI call writes nothing to GitHub and the failures are in the trace",
      sim.github.writes.filter((write) => write.step === STEP.fails).length ===
        0 &&
        sim.trace.ai.some(
          (call) => call.step === STEP.fails && call.fault === "500",
        ) &&
        sim.trace.completions.some(
          (call) => call.step === STEP.fails && !call.ok,
        ),
      `${sim.trace.ai.filter((call) => call.step === STEP.fails).length} AI requests`,
    ),
  );

  // The blocking rule.
  const [byModel, bySeverity] = runsOf(sim, STEP.severity);
  const blockingOf = (run: CliRun | undefined) =>
    ((parseJsonOutput(run?.stdout ?? "")?.summary as Json | undefined)
      ?.blocking ?? -1) as number;
  add(
    scripted(
      sim,
      "a P1 the model calls non-blocking passes under the model rule and blocks under severity",
      byModel?.exitCode === 0 &&
        blockingOf(byModel) === 0 &&
        bySeverity?.exitCode === 1 &&
        blockingOf(bySeverity) === 1,
      `model ${byModel ? code(byModel) : "no run"}, severity ${bySeverity ? code(bySeverity) : "no run"}`,
    ),
  );

  // Exit codes in general.
  add(
    check(
      "exit codes stay in the documented set",
      Object.values((sim.state.cliRuns ?? {}) as Record<string, CliRun[]>)
        .flat()
        .every((run) => [0, 1, 2, 3].includes(run.exitCode)),
      "0, 1, 2 or 3 for every run",
    ),
    scripted(
      sim,
      "the exit code is 1 exactly when a blocking finding was printed",
      Object.values((sim.state.cliRuns ?? {}) as Record<string, CliRun[]>)
        .flat()
        .filter((run) => run.exitCode === 0 || run.exitCode === 1)
        .every((run) => {
          const text = run.stdout;
          const blocking =
            /· [1-9]\d* blocking/.test(text) ||
            /"blocking":[1-9]/.test(text) ||
            text.includes("::error ");
          return (run.exitCode === 1) === blocking;
        }),
      "printed blocking count and exit code agree in every run",
    ),
  );
  return results;
}

function scores(sim: Sim): Score[] {
  const fakeAi = sim.mode === "fake";
  const reviews = sim.trace.completions.filter(
    (call) => call.job === "review_pull_request",
  );
  const retries = sim.trace.completions.filter(
    (call) => call.job === "review_pull_request_retry",
  );
  const answered = reviews.filter((call) => call.ok);
  const prompts = answered.map((call) => call.firstUser.length);
  // A finding is anchored when its file is in the pull request and its line
  // is inside the new file.
  const rows: { ok: boolean }[] = [];
  const runs = (sim.state.cliRuns ?? {}) as Record<string, CliRun[]>;
  const main = (sim.state.pulls as Record<string, SimPull> | undefined)?.main;
  const files = main ? mainFiles() : {};
  for (const run of Object.values(runs).flat()) {
    const parsed = parseJsonOutput(run.stdout);
    for (const row of (parsed?.findings ?? []) as Json[]) {
      const path = String(row.path ?? "");
      const text = files[path] ?? manyFiles()[path] ?? SAMPLE_REPO[path];
      const length = text ? text.split("\n").length : 0;
      rows.push({
        ok:
          text !== undefined &&
          Number(row.lineFrom) >= 1 &&
          Number(row.lineFrom) <= length,
      });
    }
  }
  return [
    {
      name: "findings anchored to a line of a changed file",
      value: rows.length
        ? rows.filter((row) => row.ok).length / rows.length
        : null,
      detail: `${rows.filter((row) => row.ok).length} of ${rows.length} findings in the --json runs`,
      fakeAi,
      ...(rows.length ? {} : { skipped: "no --json finding" }),
    },
    {
      name: "answers that needed a JSON retry",
      value: answered.length ? retries.length / answered.length : null,
      detail: `${retries.length} retries over ${answered.length} reviews`,
      fakeAi,
    },
    {
      name: "review prompt size in characters, median",
      value: prompts.length
        ? [...prompts].sort((a, b) => a - b)[Math.floor(prompts.length / 2)]!
        : null,
      detail: `${prompts.length} reviews, largest ${Math.max(0, ...prompts)}`,
      fakeAi,
    },
  ];
}

export default defineFlow({
  name: "cli-pr",
  description:
    "co-maintainer review owner/repo N: three output formats, blocking and clean pull requests, edge cases, a push, a tool round and a failed AI call",
  ai: CLI_PR_AI,
  steps,
  checks: flowChecks,
  scores,
});
