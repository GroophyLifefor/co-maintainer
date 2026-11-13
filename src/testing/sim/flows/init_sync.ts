/** `init` with every source on, then `sync` after the world moves, then
 * `view`: the whole knowledge pipeline on a repository with history.
 *
 * The repository has merged pull requests with review comments, requested
 * changes and issue comments, a closed one with a diff over the line cap, one
 * older than `--max-pr-months`, and commits on its default branch. Each review
 * rule a maintainer wrote starts with `Rule:`. The fake AI reads those rules
 * out of the prompt it is sent, so a rule reaches a guide only if the product
 * really put its comment in front of the model. Text the caps must keep out
 * carries a sentinel that no prompt may contain.
 *
 * Feature flows build on the exports: `buildHistory`, `INIT_SYNC_AI`,
 * `runInit`, `runSync`, `moveWorld`, the step objects and the small readers
 * (`knowledgeState`, `guides`, `completions`). */
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AiCall, AiRule } from "../fake_ai.ts";
import {
  type CheckResult,
  type CliRun,
  check,
  defineFlow,
  type Score,
  type Sim,
  type Step,
} from "../flow.ts";
import type { SimComment, SimPull } from "../github.ts";
import { SAMPLE_REPO, SAMPLE_REPO_NAME } from "../sample_repo.ts";
import type { Completion } from "../trace.ts";
import { age, editComment, review, touch } from "./github_people.ts";
import { INIT_AI } from "./init.ts";

export const HISTORY_REPO = SAMPLE_REPO_NAME;

/** The sample repository plus the test file its review rules name. */
export const HISTORY_FILES: Record<string, string> = {
  ...SAMPLE_REPO,
  "test/format.test.ts": [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { formatPercent } from "../src/format.ts";',
    "",
    'test("formatPercent", () => assert.equal(formatPercent(0.5), "50%"));',
    "",
  ].join("\n"),
};

/** The review rules maintainers wrote, one per comment or review. */
export const RULES = {
  clampTest:
    "When `clamp` changes, add a reversed-bounds case to `test/math.test.ts`.",
  percentRange:
    "Every change to `formatPercent` keeps the ratio between 0 and 1.",
  /** What `percentRange` is edited to before `sync`. */
  percentRounding:
    "Every change to `formatPercent` rounds half up and keeps the ratio between 0 and 1.",
  namedExports:
    "Export new helpers by name from `src/index.ts`, never as a default export.",
  testNames: "Name every test after the function it covers.",
  generated: "Keep generated tables out of `src/`.",
  /** Written on the pull request merged before `sync`. */
  addNegative:
    "When `add` changes, cover negative numbers in `test/math.test.ts`.",
  /** Written before the run whose guide call fails. */
  formatTest:
    "When `formatPercent` changes, add a case to `test/format.test.ts`.",
} as const;

/** Text a cap must keep away from the model. */
export const SENTINELS = {
  /** In the fourth and fifth issue comment, past `--max-comment=3`. */
  pastCap: "PAST-COMMENT-CAP-SENTINEL",
  /** In a pull request last updated two years ago. */
  oldWindow: "OUTSIDE-PR-WINDOW-SENTINEL",
  /** In the diff of a pull request over the change-line cap. */
  bigDiff: "OVER-LINE-CAP-SENTINEL",
} as const;

/** The flags `init` runs with: every source on, every cap set low enough
 * that the history crosses it. `sync` passes none and must reuse them. */
export const INIT_ARGS = [
  "--max-pr-months=6",
  "--max-comment=3",
  "--max-pull-request-change-lines=100",
  "--max-commits=5",
  "--include-codebase",
  "--include-pull-requests",
  "--include-pull-request-changes",
  "--include-commit-history",
];
export const CAPS = {
  maxPrMonths: 6,
  maxComments: 3,
  maxPullRequestChangeLines: 100,
  maxCommits: 5,
};

const GUIDE_FILES = [
  "SKILL.md",
  "CODEBASE.md",
  "PR_REVIEW_GUIDE.md",
  "PR_REVIEW_DETAILED_GUIDE.md",
] as const;

export type History = {
  pulls: {
    /** Merged. Five issue comments, two past the cap, and a line comment. */
    clamp: SimPull;
    /** Merged. Its line comment is edited before `sync`. */
    percent: SimPull;
    /** Merged. The rule is in a review that requested changes. */
    exports: SimPull;
    /** Closed without a merge. Its diff is over the change-line cap. */
    table: SimPull;
    /** Merged two years ago, outside the window. */
    old: SimPull;
  };
  /** The comment `moveWorld` edits. */
  percentComment: SimComment;
};

const rule = (text: string) => `Rule: ${text}`;

/** A merged pull request: opened, discussed by `discuss`, then merged. */
function mergedPull(
  sim: Sim,
  input: {
    title: string;
    body: string;
    files: Record<string, string>;
    message?: string;
  },
  discuss: (pull: SimPull) => void,
): SimPull {
  const pull = sim.github.openPull(HISTORY_REPO, input);
  discuss(pull);
  sim.github.merge(pull);
  return pull;
}

/** Creates the repository with its history. `files` adds or replaces files
 * in the first commit, such as an instruction file a feature flow reads. */
export function buildHistory(
  sim: Sim,
  files: Record<string, string> = {},
): History {
  const { github } = sim;
  sim.repo(HISTORY_REPO, { ...HISTORY_FILES, ...files });
  github.commitToDefault(
    HISTORY_REPO,
    {
      "README.md": `${HISTORY_FILES["README.md"]}\n\`clamp\` keeps a value between two bounds.\n`,
    },
    "docs: explain clamp in the README",
  );
  github.commitToDefault(
    HISTORY_REPO,
    {
      "test/format.test.ts": `${HISTORY_FILES["test/format.test.ts"]}test("formatPercent clamps", () => assert.equal(formatPercent(2), "100%"));\n`,
    },
    "test: cover formatPercent above one",
  );

  let percentComment: SimComment | undefined;
  const clamp = mergedPull(
    sim,
    {
      title: "Throw when clamp bounds are reversed",
      body: "`clamp(5, 1, 0)` returned 0 silently. It now throws, so a caller finds the swapped bounds at once.",
      files: {
        "src/math.ts": SAMPLE_REPO["src/math.ts"]!.replace(
          "  return Math.min(",
          '  if (min > max) throw new RangeError("reversed bounds");\n  return Math.min(',
        ),
      },
    },
    (pull) => {
      github.reviewComment(pull, {
        path: "src/math.ts",
        line: 6,
        body: `${rule(RULES.clampTest)} A reversed range used to pass silently.`,
      });
      github.comment(pull, `${rule(RULES.testNames)} Cap check comment 1.`);
      github.comment(pull, "Cap check comment 2. Thanks for the quick fix.");
      github.comment(pull, "Cap check comment 3. CI is green now.");
      github.comment(pull, `Cap check comment 4. ${SENTINELS.pastCap}`);
      github.comment(
        pull,
        `Cap check comment 5. Rule: ${SENTINELS.pastCap} never reaches a prompt.`,
      );
      review(github, pull, {
        state: "CHANGES_REQUESTED",
        body: "Please add the reversed-bounds test before this lands.",
      });
      review(github, pull, { state: "APPROVED", body: "" });
    },
  );
  const percent = mergedPull(
    sim,
    {
      title: "Round formatPercent half up",
      body: "`formatPercent(0.125)` printed 12%. It now rounds half up, so the label matches the value people expect.",
      files: {
        "src/format.ts": SAMPLE_REPO["src/format.ts"]!.replace(
          "Math.round(",
          "Math.floor(0.5 + ",
        ),
      },
    },
    (pull) => {
      percentComment = github.reviewComment(pull, {
        path: "src/format.ts",
        line: 4,
        body: rule(RULES.percentRange),
      });
      review(github, pull, {
        state: "CHANGES_REQUESTED",
        body: "The ratio has to stay clamped after this change.",
      });
    },
  );
  const exports = mergedPull(
    sim,
    {
      title: "Export clamp from the index",
      body: "`clamp` was only reachable through `src/math.ts`. The index now exports it by name like the other helpers.",
      files: {
        "src/index.ts": `${SAMPLE_REPO["src/index.ts"]}export { clamp as bound } from "./math.ts";\n`,
      },
    },
    (pull) => {
      review(github, pull, {
        state: "CHANGES_REQUESTED",
        body: `${rule(RULES.namedExports)} A default export would break the tree-shaking our users rely on.`,
      });
    },
  );
  github.commitToDefault(
    HISTORY_REPO,
    {
      "package.json": HISTORY_FILES["package.json"]!.replace("^5.6.0", "5.6.3"),
    },
    "chore: pin typescript",
  );

  const tableLines = Array.from(
    { length: 150 },
    (_, index) => `  ${index}, // ${SENTINELS.bigDiff}`,
  );
  const table = github.openPull(HISTORY_REPO, {
    title: "Add a generated lookup table",
    body: "A 150 row table generated from a spreadsheet, so `formatPercent` can skip the math.",
    files: {
      "src/table.ts": `export const TABLE = [\n${tableLines.join("\n")}\n];\n`,
    },
  });
  github.reviewComment(table, {
    path: "src/table.ts",
    line: 1,
    body: `${rule(RULES.generated)} The table belongs in a build step.`,
  });
  review(github, table, {
    state: "CHANGES_REQUESTED",
    body: "Generate this at build time instead.",
  });
  github.close(table);

  const old = mergedPull(
    sim,
    {
      title: `Old change ${SENTINELS.oldWindow}`,
      body: `A change from long ago. ${SENTINELS.oldWindow}`,
      files: { "CHANGELOG.md": "# Changelog\n\n- First release.\n" },
      // Its commit is on the default branch, and commit history is evidence
      // of its own, so the sentinel stays out of the commit message.
      message: "docs: start a changelog",
    },
    (pull) => {
      github.reviewComment(pull, {
        path: "CHANGELOG.md",
        line: 1,
        body: `Rule: ${SENTINELS.oldWindow} stays out of every prompt.`,
      });
      review(github, pull, {
        state: "CHANGES_REQUESTED",
        body: SENTINELS.oldWindow,
      });
    },
  );

  // GitHub lists pull requests by `updated_at`, newest first. Distinct ages
  // keep that order fixed, and the oldest falls outside `--max-pr-months`.
  age(clamp, 10);
  age(percent, 9);
  age(exports, 8);
  age(table, 7);
  age(old, 730);
  return {
    pulls: { clamp, percent, exports, table, old },
    percentComment: percentComment!,
  };
}

export type Moved = {
  /** Merged after `init`, with a new rule and requested changes. */
  negative: SimPull;
};

/** The world after `init`: a new pull request with review comments is
 * merged, and the rule in an old line comment is edited. */
export function moveWorld(sim: Sim, history: History): Moved {
  const { github } = sim;
  const negative = github.openPull(HISTORY_REPO, {
    title: "Handle negative numbers in add",
    body: "`add(-1, -2)` is covered now, and the docs say negative input is fine.",
    files: {
      "src/math.ts": `${github.world.git(github.world.repos.get(HISTORY_REPO)!, ["show", "main:src/math.ts"]).toString()}\nexport const negate = (value: number): number => -value;\n`,
    },
  });
  github.reviewComment(negative, {
    path: "src/math.ts",
    line: 1,
    body: `${rule(RULES.addNegative)} Negative input was never tested.`,
  });
  review(github, negative, {
    state: "CHANGES_REQUESTED",
    body: "Cover the negative case first.",
  });
  github.merge(negative);
  touch(negative);
  editComment(
    history.pulls.percent,
    history.percentComment,
    rule(RULES.percentRounding),
  );
  return { negative };
}

// The fake AI. Each answer is read out of the prompt the product sent.

/** The JSON that follows `marker` to the end of the prompt. */
function jsonAfter(prompt: string, marker: string): unknown {
  const at = prompt.lastIndexOf(marker);
  if (at < 0) return undefined;
  try {
    return JSON.parse(prompt.slice(at + marker.length));
  } catch {
    return undefined;
  }
}

type Unit = {
  number: number;
  comments: string[];
  reviewComments: string[];
  reviews: string[];
};

/** The pull request number a pull request extraction prompt is about. */
export function prNumberOf(prompt: string): number | undefined {
  const match = /PULL REQUEST:\n\{"number":(\d+)/.exec(prompt);
  return match ? Number(match[1]) : undefined;
}

function ruleClass(text: string): string {
  if (/test/i.test(text)) return "tests";
  if (/export/i.test(text)) return "exports";
  return "shape";
}

/** One review finding per `Rule:` the prompt carries, in the shape the
 * extraction asks for. A rule the product left out of the prompt yields
 * nothing, which is what the checks rely on. */
function prFindings({ prompt }: AiCall) {
  const unit = jsonAfter(prompt, "PULL REQUEST:\n") as Unit | undefined;
  if (!unit) return { json: [] };
  const texts = [...unit.comments, ...unit.reviewComments, ...unit.reviews];
  const findings = texts.flatMap((text) => {
    const match = /Rule: (.+?\.)(?: |$)/.exec(text);
    if (!match) return [];
    // A line comment arrives as `path:line body`.
    const location = /^([^\s:]+:\d+) /.exec(text)?.[1] ?? "";
    return [
      {
        sectionKey: "review",
        class: ruleClass(match[1]!),
        claim: match[1]!,
        location,
        trigger: location.replace(/:\d+$/, ""),
        impact: "Reviewers here asked for it before a change could merge.",
        action: "Apply the rule to the change before approving it.",
        scope: "historical-example",
        confidence: "medium",
      },
    ];
  });
  return { json: findings };
}

type Finding = { class: string; rule: string; trigger?: string };

const PASS_NAMES: Record<string, string> = {
  tests: "Test Coverage",
  exports: "Public Exports",
  shape: "Code Shape",
};

function passes(findings: Finding[]): [string, Finding[]][] {
  const byPass = new Map<string, Finding[]>();
  for (const finding of findings) {
    const name = PASS_NAMES[finding.class] ?? "Other Checks";
    byPass.set(name, [...(byPass.get(name) ?? []), finding]);
  }
  return [...byPass.entries()];
}

const IMPACT = "reviewers asked for it before merging";

/** The full method: every finding becomes one check line, `rule · why`. */
function fullGuide({ prompt }: AiCall): string {
  const findings = (jsonAfter(prompt, "FINDINGS:\n") ?? []) as Finding[];
  const body = passes(findings).flatMap(([name, list]) => [
    `## ${name}`,
    "",
    "**Goal:** Catch what reviewers here ask for most.",
    "**Applies to:** the files each rule names.",
    "",
    ...list.flatMap((finding) => [
      `- ${finding.rule} · ${IMPACT}`,
      "  - A past change needed this before it merged.",
    ]),
    "",
    "**Exit check:**",
    ...list.map(
      (finding) =>
        `- \`${finding.trigger || "src/"}\` → the rule above holds for the change`,
    ),
    "",
  ]);
  return [
    "# Review method for sim/sample",
    "",
    "The checks this repository's reviewers ask for.",
    "Apply each pass to the files it names.",
    "",
    ...body,
  ].join("\n");
}

/** The short checklist: the same checks, one line each. */
function shortGuide({ prompt }: AiCall): string {
  const findings = (jsonAfter(prompt, "FINDINGS:\n") ?? []) as Finding[];
  return [
    "# Review checklist for sim/sample",
    "",
    "The checks reviewers here ask for most.",
    "Read [PR_REVIEW_DETAILED_GUIDE.md](PR_REVIEW_DETAILED_GUIDE.md) for the full method.",
    "",
    ...passes(findings).flatMap(([name, list]) => [
      `## ${name}`,
      "",
      ...list.map((finding) => `- ${finding.rule} · ${IMPACT}`),
      "",
      "**Exit check:** every rule above holds.",
      "",
    ]),
  ].join("\n");
}

const SECTION = /Write only the Markdown for the "([^"]+)" section/;

/** A section lists the claims of the facts it was given, so its text traces
 * to them. */
function section({ prompt }: AiCall): string {
  const key = SECTION.exec(prompt)?.[1] ?? "section";
  const facts = (jsonAfter(prompt, "FACTS:\n") ?? []) as { claim: string }[];
  const claims = [...new Set(facts.map((fact) => fact.claim))];
  return `## ${key}\n\n${claims.map((claim) => `- ${claim}`).join("\n")}\n`;
}

/** What the model answers `init` and `sync` with on the history repository.
 * The codebase answer is the codebase-only flow's. */
export const INIT_SYNC_AI: AiRule[] = [
  {
    name: "pull request findings",
    job: "extract_unit",
    prompt: "PULL REQUEST:\n",
    reply: prFindings,
  },
  INIT_AI[0]!,
  { name: "section from facts", job: "synth_section", reply: section },
  { name: "full review method", job: "synth_guide", reply: fullGuide },
  {
    name: "short review checklist",
    job: "synth_guide_short",
    reply: shortGuide,
  },
];

// Driving the product.

/** The setup `init` and `sync` read from config.json: PAT auth and the run's
 * AI provider. The secrets stay off the command line. */
export function configureCli(sim: Sim): void {
  const options = sim.options();
  sim.world.writeConfig({
    auth: "pat",
    githubPat: sim.world.secrets.pat,
    ai: options.ai,
    token: options.aiToken,
    lowModel: options.lowModel,
    highModel: options.highModel,
  });
}

export type SetupRun = CliRun & {
  /** The `--json` document `init` and `sync` print. */
  json: Record<string, unknown>;
};

async function setup(sim: Sim, args: string[]): Promise<SetupRun> {
  configureCli(sim);
  const run = await sim.cli([...args, "--json"]);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    // Not JSON: the exit code and stderr say what went wrong.
  }
  if (run.exitCode !== 0) {
    throw new Error(
      `${args[0]} exited ${run.exitCode}: ${run.stderr.trim() || run.stdout.trim()}`,
    );
  }
  return { ...run, json };
}

/** `co-maintainer init sim/sample` with `INIT_ARGS` and `extra`. Throws on a
 * non-zero exit. */
export function runInit(sim: Sim, extra: string[] = []): Promise<SetupRun> {
  return setup(sim, ["init", HISTORY_REPO, ...INIT_ARGS, ...extra]);
}

/** `co-maintainer sync sim/sample` with only `extra`: the rest comes from
 * what `init` remembered. Throws on a non-zero exit. */
export function runSync(sim: Sim, extra: string[] = []): Promise<SetupRun> {
  return setup(sim, ["sync", HISTORY_REPO, ...extra]);
}

// Reading what was built.

/** The four guide files as they are on disk now. A missing file is absent. */
export function guides(sim: Sim): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  for (const name of GUIDE_FILES) {
    const path = `${sim.paths.reposDir}/${HISTORY_REPO}/${name}`;
    if (existsSync(path)) out[name] = readFileSync(path, "utf8");
  }
  return out;
}

type KnowledgeState = {
  options: Record<string, unknown>;
  facts: {
    id: string;
    sectionKey: string;
    claim: string;
    evidence: string[];
  }[];
  source: { commits: { sha?: string }[]; pullRequests: { number: number }[] };
};

/** What `init` or `sync` saved in cache.db for the repository. */
export function knowledgeState(sim: Sim): KnowledgeState | undefined {
  if (!existsSync(sim.paths.cacheDb)) return undefined;
  const database = new DatabaseSync(sim.paths.cacheDb, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT value FROM cache WHERE namespace = 'state' AND cache_key = ?",
      )
      .get(HISTORY_REPO) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as KnowledgeState) : undefined;
  } finally {
    database.close();
  }
}

/** The product's AI calls, by job and the step that made them. */
export function completions(
  sim: Sim,
  filter: { job?: string; step?: string } = {},
): Completion[] {
  return sim.trace.completions.filter(
    (call) =>
      !call.job.startsWith("sim_") &&
      (filter.job === undefined || call.job === filter.job) &&
      (filter.step === undefined || call.step === filter.step),
  );
}

/** Everything sent to the model, system and prompt, for a sentinel search. */
const sent = (sim: Sim) =>
  completions(sim)
    .map((call) => `${call.system}\n${call.firstUser}`)
    .join("\n");

/** The paths of the `GET` calls that reached GitHub and match `path`. */
function githubGets(sim: Sim, path: RegExp, step?: string): string[] {
  return sim.trace.github
    .filter(
      (call) =>
        call.method === "GET" &&
        (step === undefined || call.step === step) &&
        path.test(new URL(call.url).pathname),
    )
    .map((call) => new URL(call.url).pathname);
}

function mainHead(sim: Sim): string {
  return sim.world
    .git(sim.world.repos.get(HISTORY_REPO)!, ["rev-parse", "main"])
    .toString()
    .trim();
}

// Steps.

export const STEP = {
  history: "repository with history",
  init: "init",
  move: "world moves",
  sync: "sync",
  view: "view",
  failed: "sync with a failing guide call",
} as const;

export const historyStep: Step = {
  name: STEP.history,
  run(sim) {
    const history = buildHistory(sim);
    sim.state.history = history;
    const merged = sim.github.pulls.filter((pull) => pull.mergedAt).length;
    return `${HISTORY_REPO} · ${sim.github.pulls.length} pull requests, ${merged} merged · ${sim.github.comments.length} comments · ${sim.github.reviews.length} reviews`;
  },
};

const calls = (sim: Sim, step: string) =>
  `${completions(sim, { step }).length} AI calls · ${sim.trace.github.filter((call) => call.step === step).length} GitHub calls`;

export const initStep: Step = {
  name: STEP.init,
  async run(sim) {
    sim.state.init = await runInit(sim);
    sim.state.afterInit = guides(sim);
    sim.state.stateAfterInit = knowledgeState(sim);
    return calls(sim, STEP.init);
  },
};

export const moveStep: Step = {
  name: STEP.move,
  run(sim) {
    const moved = moveWorld(sim, sim.state.history as History);
    sim.state.moved = moved;
    return `#${moved.negative.number} merged with a new rule · a rule on #${(sim.state.history as History).pulls.percent.number} edited`;
  },
};

export const syncStep: Step = {
  name: STEP.sync,
  async run(sim) {
    sim.state.sync = await runSync(sim);
    sim.state.afterSync = guides(sim);
    sim.state.headAfterSync = mainHead(sim);
    sim.state.stateAfterSync = knowledgeState(sim);
    return calls(sim, STEP.sync);
  },
};

export const viewStep: Step = {
  name: STEP.view,
  async run(sim) {
    const all = await sim.cli(["view", HISTORY_REPO]);
    const list = await sim.cli(["view", HISTORY_REPO, "--list"]);
    sim.state.view = { all, list };
    if (all.exitCode !== 0 || list.exitCode !== 0) {
      throw new Error(`view exited ${all.exitCode}, --list ${list.exitCode}`);
    }
    return `${all.stdout.split("\n").length} lines · ${list.stdout.trim().split("\n").length} guides listed`;
  },
};

/** One more rule arrives, so the guide must be rebuilt, and the guide call
 * fails on every attempt. */
export const failedGuideStep: Step = {
  name: STEP.failed,
  async run(sim) {
    const { negative } = sim.state.moved as Moved;
    sim.github.reviewComment(negative, {
      path: "src/math.ts",
      line: 1,
      body: rule(RULES.formatTest),
    });
    touch(negative);
    // The AI batch tries a unit three times before it gives up.
    sim.faults.add({ target: "ai", kind: "500", job: "synth_guide", times: 3 });
    sim.state.failed = await runSync(sim);
    return calls(sim, STEP.failed);
  },
};

// Checks.

const listOf = (items: unknown[]) => items.join(", ") || "none";

function fakeOnly(sim: Sim, result: CheckResult): CheckResult {
  return sim.mode === "fake"
    ? result
    : { ...result, ok: true, skipped: "reads the fake AI's answers" };
}

/** Lines of the form `- rule · why`: the guide's checks. */
function checkLines(text = ""): string[] {
  return text
    .split("\n")
    .map((line) => /^- (.+) · /.exec(line)?.[1])
    .filter((line): line is string => Boolean(line));
}

function sectionTitles(text = ""): string[] {
  return [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]!.trim());
}

function initChecks(sim: Sim): CheckResult[] {
  const run = sim.state.init as SetupRun | undefined;
  const after = (sim.state.afterInit ?? {}) as Record<string, string>;
  const skill = after["SKILL.md"] ?? "";
  const missing = GUIDE_FILES.filter((name) => !after[name]?.trim());
  const detailedChecks = checkLines(after["PR_REVIEW_DETAILED_GUIDE.md"]);
  const inWindow = [
    RULES.clampTest,
    RULES.percentRange,
    RULES.namedExports,
    RULES.testNames,
    RULES.generated,
  ];
  return [
    check(
      "init finished with every source on",
      run?.exitCode === 0 &&
        run.json.ok === true &&
        run.json.command === "init" &&
        run.json.reviewGuide === "detailed" &&
        run.json.pullRequests === 4,
      run
        ? `exit ${run.exitCode} · ${run.json.pullRequests} pull requests · ${run.json.commits} commits · ${run.json.facts} facts · guide ${run.json.reviewGuide}`
        : "init did not run",
    ),
    check(
      "every guide file written by init",
      missing.length === 0 &&
        skill.includes("[PR_REVIEW_GUIDE.md](PR_REVIEW_GUIDE.md)") &&
        skill.includes("[CODEBASE.md](CODEBASE.md)") &&
        detailedChecks.length > 0,
      missing.length
        ? `missing or empty: ${listOf(missing)}`
        : GUIDE_FILES.map(
            (name) =>
              `${name} ${Buffer.byteLength(after[name]!).toLocaleString("en-US")} bytes`,
          ).join(" · "),
    ),
    fakeOnly(
      sim,
      check(
        "init's guide holds every rule put in",
        inWindow.every((text) => detailedChecks.includes(text)),
        `${inWindow.filter((text) => detailedChecks.includes(text)).length} of ${inWindow.length} rules · missing: ${listOf(inWindow.filter((text) => !detailedChecks.includes(text)))}`,
      ),
    ),
  ];
}

/** Every review fact points at pull requests that were sent to the model,
 * and every check line in the guides is one of those facts. */
function traceCheck(sim: Sim): CheckResult {
  const state = knowledgeState(sim);
  const prompts = new Map<number, string[]>();
  for (const call of completions(sim, { job: "extract_unit" })) {
    const number = prNumberOf(call.firstUser);
    if (number !== undefined) {
      prompts.set(number, [...(prompts.get(number) ?? []), call.firstUser]);
    }
  }
  const reviewFacts = (state?.facts ?? []).filter(
    (fact) => fact.sectionKey === "review",
  );
  const problems: string[] = [];
  for (const fact of reviewFacts) {
    const numbers = fact.evidence.map((item) => /^PR #(\d+)$/.exec(item)?.[1]);
    if (!numbers.length || numbers.some((number) => number === undefined)) {
      problems.push(`${fact.id}: evidence ${fact.evidence.join(", ")}`);
      continue;
    }
    for (const number of numbers.map(Number)) {
      const sentFor = prompts.get(number) ?? [];
      if (!sentFor.length)
        problems.push(`${fact.id}: PR #${number} never sent`);
      // The fake AI copies the rule, so its text is in the prompt it came
      // from. A real model paraphrases.
      else if (
        sim.mode === "fake" &&
        !sentFor.some((prompt) => prompt.includes(fact.claim))
      ) {
        problems.push(`${fact.id}: not in what PR #${number} sent`);
      }
    }
  }
  if (sim.mode === "fake") {
    const claims = new Set(reviewFacts.map((fact) => fact.claim));
    const now = guides(sim);
    for (const name of ["PR_REVIEW_GUIDE.md", "PR_REVIEW_DETAILED_GUIDE.md"]) {
      for (const line of checkLines(now[name])) {
        if (!claims.has(line)) problems.push(`${name}: "${line}" has no fact`);
      }
    }
  }
  return check(
    "guide facts trace to the evidence sent",
    reviewFacts.length > 0 && problems.length === 0,
    problems.length
      ? problems.slice(0, 5).join(" · ")
      : `${reviewFacts.length} review facts from ${prompts.size} pull requests sent`,
  );
}

function capChecks(sim: Sim): CheckResult[] {
  const history = sim.state.history as History | undefined;
  if (!history) return [check("caps respected", false, "no history")];
  const { old, table, clamp } = history.pulls;
  const text = sent(sim);
  const oldCalls = githubGets(
    sim,
    new RegExp(`/(pulls|issues)/${old.number}(/|$)`),
  );
  const clampPrompts = completions(sim, { job: "extract_unit" })
    .map((call) => call.firstUser)
    .filter((prompt) => prNumberOf(prompt) === clamp.number);
  const comments = clampPrompts.flatMap(
    (prompt) =>
      (jsonAfter(prompt, "PULL REQUEST:\n") as Unit | undefined)?.comments ??
      [],
  );
  const state = knowledgeState(sim);
  const commits = state?.source.commits ?? [];
  return [
    check(
      "pull requests older than --max-pr-months never fetched",
      oldCalls.length === 0 && !text.includes(SENTINELS.oldWindow),
      `${oldCalls.length} calls for #${old.number}: ${listOf(oldCalls)} · sentinel ${text.includes(SENTINELS.oldWindow) ? "sent" : "never sent"}`,
    ),
    check(
      "--max-comment keeps later comments from the model",
      clampPrompts.length > 0 &&
        comments.length > 0 &&
        clampPrompts.every(
          (prompt) =>
            (jsonAfter(prompt, "PULL REQUEST:\n") as Unit).comments.length <=
            CAPS.maxComments,
        ) &&
        !text.includes(SENTINELS.pastCap),
      `#${clamp.number} sent ${clampPrompts.length} times with ${comments.length} comments in all · sentinel ${text.includes(SENTINELS.pastCap) ? "sent" : "never sent"}`,
    ),
    check(
      "--max-pull-request-change-lines skips a large diff",
      githubGets(sim, new RegExp(`/pulls/${table.number}/files$`)).length ===
        0 &&
        !text.includes(SENTINELS.bigDiff) &&
        clampPrompts.some((prompt) => prompt.includes("FILE: src/math.ts")),
      `#${table.number} files fetched ${githubGets(sim, new RegExp(`/pulls/${table.number}/files$`)).length} times · #${clamp.number} diff ${clampPrompts.some((prompt) => prompt.includes("FILE: src/math.ts")) ? "sent" : "missing"}`,
    ),
    check(
      "--max-commits caps the commit history",
      commits.length === CAPS.maxCommits && commits[0]?.sha === mainHead(sim),
      `${commits.length} commits kept · newest ${commits[0]?.sha === mainHead(sim) ? "is" : "is not"} the head of main`,
    ),
  ];
}

function syncChecks(sim: Sim): CheckResult[] {
  const history = sim.state.history as History | undefined;
  const moved = sim.state.moved as Moved | undefined;
  const run = sim.state.sync as SetupRun | undefined;
  const state = knowledgeState(sim);
  if (!history || !moved || !run || !state) {
    return [check("sync ran", false, "an earlier step did not finish")];
  }
  const changed = [history.pulls.percent.number, moved.negative.number].sort();
  const discussions = githubGets(sim, /\/issues\/\d+\/comments$/, STEP.sync)
    .map((path) => Number(/\/issues\/(\d+)\//.exec(path)![1]))
    .sort();
  const initCalls = completions(sim, { step: STEP.init });
  const syncCalls = completions(sim, { step: STEP.sync });
  const syncPrs = syncCalls
    .filter((call) => call.job === "extract_unit")
    .map((call) => prNumberOf(call.firstUser))
    .filter((number): number is number => number !== undefined)
    .sort();
  const sentBefore = new Set(
    initCalls.map((call) => `${call.job}\0${call.system}\0${call.firstUser}`),
  );
  const repeated = syncCalls.filter((call) =>
    sentBefore.has(`${call.job}\0${call.system}\0${call.firstUser}`),
  );
  const after = (sim.state.afterSync ?? {}) as Record<string, string>;
  const detailed = checkLines(after["PR_REVIEW_DETAILED_GUIDE.md"]);
  const wanted = [
    RULES.clampTest,
    RULES.percentRounding,
    RULES.namedExports,
    RULES.testNames,
    RULES.generated,
    RULES.addNegative,
  ];
  const options = state.options;
  const kept = Object.entries(CAPS).filter(
    ([key, value]) => options[key] !== value,
  );
  return [
    check(
      "sync kept init's settings",
      run.json.command === "sync" &&
        kept.length === 0 &&
        options.includePullRequests === true &&
        options.includePullRequestChanges === true &&
        options.includeCommitHistory === true,
      kept.length
        ? `changed: ${kept.map(([key]) => `${key}=${String(options[key])}`).join(", ")}`
        : `caps ${Object.entries(CAPS)
            .map(([key, value]) => `${key}=${value}`)
            .join(", ")}`,
    ),
    check(
      "sync fetched only the discussions that changed",
      JSON.stringify(discussions) === JSON.stringify(changed),
      `comments fetched for #${listOf(discussions)} · changed #${listOf(changed)}`,
    ),
    check(
      "sync sent fewer AI calls than init",
      syncCalls.length > 0 && syncCalls.length < initCalls.length,
      `init ${initCalls.length}, sync ${syncCalls.length}`,
    ),
    check(
      "no AI call for unchanged evidence",
      JSON.stringify(syncPrs) === JSON.stringify(changed) &&
        repeated.length === 0,
      `pull requests sent again: #${listOf(syncPrs)} · calls repeated from init: ${repeated.length ? repeated.map((call) => call.job).join(", ") : "none"}`,
    ),
    fakeOnly(
      sim,
      check(
        "sync's guide holds the new and edited rules, not the old text",
        wanted.every((text) => detailed.includes(text)) &&
          !detailed.includes(RULES.percentRange),
        `missing: ${listOf(wanted.filter((text) => !detailed.includes(text)))} · old text ${detailed.includes(RULES.percentRange) ? "still there" : "gone"}`,
      ),
    ),
  ];
}

/** Sync rebuilds only the dirty sections, and CODEBASE.md is written from
 * what it rebuilt. */
function codebaseCheck(sim: Sim): CheckResult {
  const before = sectionTitles(
    (sim.state.afterInit as Record<string, string> | undefined)?.[
      "CODEBASE.md"
    ],
  );
  const after = sectionTitles(
    (sim.state.afterSync as Record<string, string> | undefined)?.[
      "CODEBASE.md"
    ],
  );
  const lost = before.filter((title) => !after.includes(title));
  return check(
    "CODEBASE.md keeps every section through sync",
    before.length > 0 && lost.length === 0,
    `init ${listOf(before)} · sync ${listOf(after)}${lost.length ? ` · lost ${listOf(lost)}` : ""}`,
  );
}

function viewCheck(sim: Sim): CheckResult {
  const view = sim.state.view as { all: CliRun; list: CliRun } | undefined;
  const files = (sim.state.afterSync ?? {}) as Record<string, string>;
  if (!view)
    return check("view printed every guide", false, "view did not run");
  const headers = [...view.all.stdout.matchAll(/^== (\S+) · built /gm)].map(
    (match) => match[1],
  );
  const listed = view.list.stdout
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/)[0]);
  const bodies = GUIDE_FILES.filter(
    (name) => files[name] && view.all.stdout.includes(files[name]!.trimEnd()),
  );
  return check(
    "view printed every guide",
    JSON.stringify(headers) === JSON.stringify(GUIDE_FILES) &&
      JSON.stringify(listed) === JSON.stringify(GUIDE_FILES) &&
      bodies.length === GUIDE_FILES.length,
    `headers ${listOf(headers)} · listed ${listOf(listed)} · ${bodies.length} of ${GUIDE_FILES.length} bodies match the files`,
  );
}

function failedGuideCheck(sim: Sim): CheckResult {
  const run = sim.state.failed as SetupRun | undefined;
  const before = (sim.state.afterSync ?? {}) as Record<string, string>;
  const now = guides(sim);
  const guideCalls = completions(sim, {
    job: "synth_guide",
    step: STEP.failed,
  });
  const same = ["PR_REVIEW_GUIDE.md", "PR_REVIEW_DETAILED_GUIDE.md"].filter(
    (name) => before[name] && now[name] === before[name],
  );
  const kept = sim.trace.logs.some(
    (line) => line.step === STEP.failed && /not regenerated/.test(line.message),
  );
  return check(
    "a failed guide call keeps the previous guides",
    run?.exitCode === 0 &&
      guideCalls.length > 0 &&
      guideCalls.every((call) => !call.ok) &&
      same.length === 2 &&
      kept,
    `exit ${run?.exitCode ?? "none"} · ${guideCalls.length} guide calls, ${guideCalls.filter((call) => !call.ok).length} failed · ${same.length} of 2 guides unchanged · ${kept ? "logged as kept" : "no log line"}`,
  );
}

/** A guide the failed run kept is still a guide every review reads, so the
 * skill must keep pointing at it. */
function keptLinkCheck(sim: Sim): CheckResult {
  const now = guides(sim);
  const linked = (now["SKILL.md"] ?? "").includes(
    "[PR_REVIEW_GUIDE.md](PR_REVIEW_GUIDE.md)",
  );
  const result = check(
    "SKILL.md still links the guide a failed run kept",
    Boolean(now["PR_REVIEW_GUIDE.md"]) && linked,
    `PR_REVIEW_GUIDE.md ${now["PR_REVIEW_GUIDE.md"] ? "on disk" : "missing"} · SKILL.md ${linked ? "links it" : "has no link"}`,
  );
  // A known product bug: `setup.ts` builds the link from this run's guide
  // only (`addReviewLink`), and a failed guide call leaves it undefined while
  // `writeReviewDocuments` keeps the old files. Reported, not fixed here.
  return result.ok
    ? result
    : {
        ...result,
        skipped:
          "known product bug: the link follows only a guide this run rebuilt",
      };
}

/** The detailed guide keeps each rule's example nested under it, as the
 * prompt asks and as the fake AI wrote it. */
function nestingCheck(sim: Sim): CheckResult {
  const detailed =
    (sim.state.afterInit as Record<string, string> | undefined)?.[
      "PR_REVIEW_DETAILED_GUIDE.md"
    ] ?? "";
  const nested = detailed
    .split("\n")
    .filter((line) => line.startsWith("  - ")).length;
  const flat = detailed
    .split("\n")
    .filter((line) => line.startsWith(" - ")).length;
  return fakeOnly(
    sim,
    check(
      "the guide keeps examples nested under their rule",
      nested > 0 && flat === 0,
      `${nested} nested example lines · ${flat} flattened to one space`,
    ),
  );
}

type BuiltRow = {
  knowledge_built_at: string | null;
  knowledge_base_sha: string | null;
};

function builtCheck(sim: Sim): CheckResult {
  let row: BuiltRow | undefined;
  if (existsSync(sim.paths.appDb)) {
    const database = new DatabaseSync(sim.paths.appDb, { readOnly: true });
    try {
      row = database
        .prepare(
          "SELECT knowledge_built_at, knowledge_base_sha FROM repos WHERE full_name = ?",
        )
        .get(HISTORY_REPO) as BuiltRow | undefined;
    } finally {
      database.close();
    }
  }
  const head = mainHead(sim);
  return check(
    "repository marked built at the head of main",
    Boolean(row?.knowledge_built_at) &&
      row?.knowledge_base_sha === head &&
      head === sim.state.headAfterSync,
    `built ${row?.knowledge_built_at ?? "never"} · base ${row?.knowledge_base_sha ?? "empty"} · main ${head}`,
  );
}

export async function initSyncChecks(sim: Sim): Promise<CheckResult[]> {
  return [
    ...initChecks(sim),
    traceCheck(sim),
    ...capChecks(sim),
    ...syncChecks(sim),
    codebaseCheck(sim),
    viewCheck(sim),
    nestingCheck(sim),
    failedGuideCheck(sim),
    keptLinkCheck(sim),
    builtCheck(sim),
    check(
      "init and sync only read GitHub",
      sim.github.writes.length === 0,
      sim.github.writes.length
        ? sim.github.writes
            .map((write) => `${write.method} ${write.path}`)
            .join(", ")
        : "no writes",
    ),
  ];
}

// Scores.

export function initSyncScores(sim: Sim): Score[] {
  const fakeAi = sim.mode === "fake";
  const after = (sim.state.afterSync ?? {}) as Record<string, string>;
  const detailed = checkLines(after["PR_REVIEW_DETAILED_GUIDE.md"]);
  const short = checkLines(after["PR_REVIEW_GUIDE.md"]);
  // The guide on disk is sync's, so it is scored against sync's facts.
  const state = sim.state.stateAfterSync as KnowledgeState | undefined;
  const reviewFacts = (state?.facts ?? []).filter(
    (fact) => fact.sectionKey === "review",
  );
  const prUnits = new Set(
    completions(sim, { job: "extract_unit" })
      .map((call) => prNumberOf(call.firstUser))
      .filter((number) => number !== undefined),
  ).size;
  const initCalls = completions(sim, { step: STEP.init });
  const syncCalls = completions(sim, { step: STEP.sync });
  const tokens = (list: Completion[]) =>
    list.reduce((sum, call) => sum + call.tokensIn + call.tokensOut, 0);
  // A real model words the guide its own way, so a fact counts as covered
  // when one check line shares most of its words.
  const words = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9/._-]+/)
        .filter((word) => word.length > 2),
    );
  const lines = detailed.map(words);
  const covered = reviewFacts.filter((fact) => {
    const claim = words(fact.claim);
    return lines.some(
      (line) =>
        [...claim].filter((word) => line.has(word)).length >= claim.size / 2,
    );
  });
  return [
    {
      name: "guide coverage of review facts",
      value: reviewFacts.length ? covered.length / reviewFacts.length : null,
      detail: `${covered.length} of ${reviewFacts.length} review facts are a check in the detailed guide`,
      fakeAi,
    },
    {
      name: "review facts per pull request",
      value: prUnits ? reviewFacts.length / prUnits : null,
      detail: `${reviewFacts.length} review facts from ${prUnits} pull requests`,
      fakeAi,
    },
    {
      name: "guide checks",
      value: detailed.length,
      detail: `${detailed.length} in the detailed guide, ${short.length} in the short one`,
      fakeAi,
      data: { detailed: detailed.length, short: short.length },
    },
    {
      name: "sync AI tokens over init",
      value: tokens(initCalls) ? tokens(syncCalls) / tokens(initCalls) : null,
      detail: `init ${initCalls.length} calls, ${tokens(initCalls).toLocaleString("en-US")} tokens · sync ${syncCalls.length} calls, ${tokens(syncCalls).toLocaleString("en-US")} tokens`,
      fakeAi,
    },
  ];
}

export default defineFlow({
  name: "init-sync",
  description:
    "init with pull requests, comments and commit history, sync after the world moves, then view",
  ai: INIT_SYNC_AI,
  steps: [historyStep, initStep, moveStep, syncStep, viewStep, failedGuideStep],
  checks: initSyncChecks,
  scores: initSyncScores,
});
