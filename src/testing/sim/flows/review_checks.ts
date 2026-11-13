/** `review-checks`: measures the review checks of issue 80 for cents.
 *
 * The issue proposes seven checks (C1 to C7, `benchmark/core_v3/checks.md`)
 * and says none enters the product without numbers. This flow gets those
 * numbers from the real local review: one repository with guides, seven
 * seeded changes with their fixed twins and three clean changes
 * (`review_checks_repo.ts`), each reviewed twice. The baseline arm runs the
 * plain review, the checks arm adds the checks text with
 * `--system-prompt-file`. Nothing else differs between the two requests.
 *
 * With `--ai` the real model answers, and the scores (`review_checks_score.ts`)
 * say what the checks caught and what noise they added. The local review can
 * read an unchanged file only through codegraph, so a live run uses the
 * codegraph the shell's co-maintainer installed, when it has one, and says so
 * in a score. Without `--ai` the fake reviewer finds each seeded defect and
 * nothing else, which proves the scenarios and the scoring, not the checks.
 * `scripts/sim_report_summary.ts` applies the issue's pass rule over runs. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AiCall as FakeCall, AiReply, AiRule } from "../fake_ai.ts";
import { finding } from "../fake_ai.ts";
import {
  check,
  type CheckResult,
  defineFlow,
  type Sim,
  type Step,
} from "../flow.ts";
import {
  type Checkout,
  configureCli,
  makeCheckout,
  NO_CODEGRAPH,
  promptDiff,
  type ReviewRun,
  runReview,
} from "./local.ts";
import {
  BASE_FILES,
  type Change,
  CHECK_IDS,
  CHECKS_REPO,
  CLEAN,
  PAIRS,
  type Pair,
  resolveSpan,
  treeOf,
} from "./review_checks_repo.ts";
import {
  type Arm,
  checkRuns,
  type FindingInput,
  type Kind,
  type ReviewInput,
  reviewScores,
  tallyArm,
} from "./review_checks_score.ts";

type Json = Record<string, unknown>;

/** The checks text, read from the tree and used as it is. */
const CHECKS_SOURCE = join(
  import.meta.dirname,
  "../../../../benchmark/core_v3/checks.md",
);
/** How the product adds a `--system-prompt-file` to the system prompt. */
const BLOCK_HEAD = "\n\nCUSTOM REVIEW INSTRUCTIONS:\n";
const checksBlock = () =>
  `${BLOCK_HEAD}${readFileSync(CHECKS_SOURCE, "utf8").trim()}`;

/** Where the shell's co-maintainer keeps codegraph, read when the module
 * loads: the world clears these variables before the first step. */
const SHELL_TOOLS_DIR = (() => {
  const env = process.env;
  if (env.CM_TOOLS_DIR) return env.CM_TOOLS_DIR;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const config =
    process.platform === "win32"
      ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
      : process.platform === "darwin"
        ? join(home, "Library", "Application Support")
        : (env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return join(config, "co-maintainer", "tools");
})();

// ------------------------------------------------------------------ changes

type Entry = { change: Change; kind: Kind; pair?: Pair };

const ENTRIES: Entry[] = [
  ...PAIRS.flatMap((pair) => [
    { change: pair.seeded, kind: "seeded" as const, pair },
    { change: pair.fixed, kind: "fixed" as const, pair },
  ]),
  ...CLEAN.map((change) => ({ change, kind: "clean" as const })),
];

const ARMS: Arm[] = ["baseline", "checks"];
const label = (entry: Entry, arm: Arm) => `review ${entry.change.name}, ${arm}`;

/** The files a change touches, sorted, as the WORKSPACE line lists them. */
const touched = (change: Change) => Object.keys(change.files).sort().join(",");

/** Which change a prompt is about: the changed files pick the pair or the
 * clean change, and the seeded test picks one of a pair. */
function entryOf(prompt: string): Entry | undefined {
  const match = /^WORKSPACE:\n(.+)$/m.exec(prompt);
  let files = "";
  try {
    files = ((JSON.parse(match?.[1] ?? "{}") as Json).changedFiles as string[])
      .slice()
      .sort()
      .join(",");
  } catch {
    return undefined;
  }
  const candidates = ENTRIES.filter((entry) => touched(entry.change) === files);
  if (candidates.length === 1) return candidates[0];
  const pair = candidates[0]?.pair;
  if (!pair) return undefined;
  const kind = pair.fake.seeded(prompt) ? "seeded" : "fixed";
  return candidates.find((entry) => entry.kind === kind);
}

// ---------------------------------------------------------------- fake AI

/** The line of the first added line holding `text`, or the first added line
 * of the first file when `text` is left out. */
function addedLine(
  prompt: string,
  path?: string,
  text?: string,
): { path: string; line: number } {
  const diff = promptDiff(prompt);
  const file = path ?? [...diff.keys()][0] ?? "";
  for (const [line, row] of diff.get(file) ?? []) {
    if (text === undefined || row.includes(text)) return { path: file, line };
  }
  return { path: file, line: 1 };
}

function seededFinding(
  pair: Pair,
  prompt: string,
  options: { severity?: "P1" | "P2" | "P3"; tag?: boolean } = {},
): Json {
  const at = addedLine(prompt, pair.fake.path, pair.fake.marker);
  const severity =
    options.severity ?? (pair.check === "C7" ? "P3" : ("P2" as const));
  return finding({
    path: at.path,
    line: at.line,
    title: `The ${pair.check} defect of this scenario`,
    body: `${options.tag ? `[${pair.check}] ` : ""}The fake reviewer found the seeded defect.`,
    severity,
  });
}

function noise(
  prompt: string,
  severity: "P2" | "P3",
  tag: string,
  path?: string,
  line?: number,
): Json {
  const at = addedLine(prompt);
  return finding({
    path: path ?? at.path,
    line: line ?? at.line,
    title: "A finding the change does not deserve",
    body: `${tag ? `[${tag}] ` : ""}The fake reviewer reports noise here on purpose.`,
    severity,
  });
}

/** The baseline reviewer: one finding on each seeded defect, nothing else. */
function baselineReply(call: FakeCall): AiReply {
  const entry = entryOf(call.prompt);
  if (entry?.kind === "seeded" && entry.pair) {
    return { findings: [seededFinding(entry.pair, call.prompt)] };
  }
  return { findings: [] };
}

/** The checks-arm reviewer, scripted so the scores have one known answer:
 * catches with and without a tag, a miss, a catch at P3 that does not count,
 * an "other" finding, and false findings with and without a tag. */
const CHECKS_SCRIPT: Record<string, (prompt: string, pair?: Pair) => Json[]> = {
  "c1-seeded": (prompt, pair) => [
    seededFinding(pair!, prompt, { severity: "P1", tag: true }),
  ],
  "c2-seeded": () => [],
  "c2-fixed": (prompt) => [noise(prompt, "P2", "C2")],
  "c3-seeded": (prompt, pair) => [
    seededFinding(pair!, prompt, { tag: true }),
    noise(prompt, "P2", "", "src/sessions/ingest.ts", 1),
  ],
  "c4-seeded": (prompt, pair) => [
    seededFinding(pair!, prompt, { severity: "P1" }),
  ],
  "c5-seeded": (prompt, pair) => [
    seededFinding(pair!, prompt, { severity: "P3", tag: true }),
  ],
  "c5-fixed": (prompt) => [noise(prompt, "P2", "")],
  "c6-seeded": (prompt, pair) => [seededFinding(pair!, prompt, { tag: true })],
  "c6-fixed": (prompt) => [noise(prompt, "P3", "C6")],
  "c7-seeded": (prompt, pair) => [seededFinding(pair!, prompt, { tag: true })],
  "clean-duration": (prompt) => [noise(prompt, "P2", "C3")],
  "clean-invoice-order": (prompt) => [noise(prompt, "P3", "")],
};

/** What the scoring must make of `CHECKS_SCRIPT` and `baselineReply`. */
export const EXPECTED = {
  baseline: { catches: 7, falseFindings: 0, p3: 0, other: 0 },
  checks: {
    catches: { C1: 1, C2: 0, C3: 1, C4: 1, C5: 0, C6: 1, C7: 1 },
    falseByChange: { "c2-fixed": 1, "c5-fixed": 1, "clean-duration": 1 },
    p3: 2,
    falseTagged: { C2: 1, C3: 1 },
    falseUntagged: 1,
    taggedCatches: { C1: 1, C3: 1, C6: 1, C7: 1 },
    other: 2,
    lowAtSeed: { C5: 1 },
  },
};

function checksReply(call: FakeCall): AiReply {
  const entry = entryOf(call.prompt);
  const script = entry ? CHECKS_SCRIPT[entry.change.name] : undefined;
  return { findings: script ? script(call.prompt, entry?.pair) : [] };
}

/** What init needs for `sim/tally`, in the shape `INIT_AI` answers it. */
const TALLY_SECTIONS: Record<string, string[]> = {
  identity: ["`sim/tally` meters API usage and bills it against budgets."],
  layout: [
    "Service code lives in `src/`, the local stack in `devstack/`.",
    "Unit tests live in `test/`.",
  ],
  tests: ["Run the unit tests with `npm test`."],
  style: ["Use named exports, not default exports."],
  devloop: ["Type-check with `npm run check` before opening a pull request."],
  ship: ["CI runs `npm run check` and `npm test` on every pull request."],
};
const SECTION = /Write only the Markdown for the "([^"]+)" section/;

const AI: AiRule[] = [
  {
    name: "reviewer with the checks",
    job: "review_local",
    prompt: `${BLOCK_HEAD.trimStart()}REVIEW CHECKS`,
    reply: checksReply,
  },
  {
    name: "reviewer without the checks",
    job: "review_local",
    reply: baselineReply,
  },
  {
    name: "codebase facts",
    job: "extract_unit",
    prompt: "canonical repository files",
    reply: {
      json: [
        {
          sectionKey: "layout",
          claim:
            "Service code lives in `src/` and the local stack in `devstack/`.",
          scope: "current",
          confidence: "high",
        },
      ],
    },
  },
  {
    name: "section",
    job: "synth_section",
    prompt: SECTION,
    reply: ({ prompt }) => {
      const key = SECTION.exec(prompt)![1]!;
      const bullets = TALLY_SECTIONS[key] ?? [
        "Follow the repository convention.",
      ];
      return `## ${key}\n\n${bullets.map((line) => `- ${line}`).join("\n")}\n`;
    },
  },
];

// ------------------------------------------------------------------- state

type State = {
  dir: string;
  checksFile: string;
  intents: Map<string, string>;
  /** The shell's codegraph tools folder, when a live run can use it. */
  tools?: string;
  codegraphReason: string;
  runs: Map<string, ReviewRun>;
  checkouts: Map<string, Checkout>;
};

function state(sim: Sim): State {
  return (sim.state.reviewChecks ??= {
    dir: join(sim.world.root, "review-checks"),
    checksFile: "",
    intents: new Map(),
    codegraphReason: "",
    runs: new Map(),
    checkouts: new Map(),
  }) as State;
}

// ------------------------------------------------------------------- steps

async function prepare(sim: Sim): Promise<string> {
  const s = state(sim);
  mkdirSync(s.dir, { recursive: true });
  s.checksFile = join(s.dir, "checks.md");
  writeFileSync(s.checksFile, readFileSync(CHECKS_SOURCE, "utf8"));
  for (const { change } of ENTRIES) {
    if (change.intent === undefined) continue;
    const path = join(s.dir, `${change.name}.intent.md`);
    writeFileSync(path, `${change.intent}\n`);
    s.intents.set(change.name, path);
  }
  if (sim.mode === "fake") {
    s.codegraphReason = "fake AI: the reviews run without codegraph";
  } else {
    const { binaryPath, codegraphVersion } =
      await import("../../../tools/codegraph.ts");
    const version = codegraphVersion();
    if (existsSync(binaryPath(version, SHELL_TOOLS_DIR))) {
      s.tools = SHELL_TOOLS_DIR;
      s.codegraphReason = `codegraph ${version} from ${SHELL_TOOLS_DIR}`;
    } else {
      s.codegraphReason = `codegraph ${version} is not installed in ${SHELL_TOOLS_DIR}, so no review can read an unchanged file and the seeded evidence is out of reach`;
    }
  }
  for (const { change } of ENTRIES) {
    s.checkouts.set(
      change.name,
      makeCheckout(sim, {
        name: change.name,
        repo: CHECKS_REPO,
        branch: "work",
        committed: change.files,
      }),
    );
  }
  return `${ENTRIES.length} checkouts · ${s.intents.size} intent files · ${s.codegraphReason}`;
}

function reviewArgs(sim: Sim, entry: Entry, arm: Arm): string[] {
  const s = state(sim);
  const intent = s.intents.get(entry.change.name);
  return [
    ...(s.tools ? [] : [NO_CODEGRAPH]),
    "--json",
    "--fresh",
    ...(arm === "checks" ? [`--system-prompt-file=${s.checksFile}`] : []),
    ...(intent ? [`--intent-file=${intent}`] : []),
  ];
}

/** One review is one step, so the step timeout covers one review. A live
 * review with codegraph can take several tool rounds. */
const reviewStep = (entry: Entry, arm: Arm): Step => ({
  name: label(entry, arm),
  timeoutMs: 600_000,
  async run(sim) {
    const s = state(sim);
    const co = s.checkouts.get(entry.change.name)!;
    const run = await runReview(
      sim,
      co,
      label(entry, arm),
      reviewArgs(sim, entry, arm),
      s.tools ? { env: { CM_TOOLS_DIR: s.tools } } : {},
    );
    s.runs.set(label(entry, arm), run);
    const found = (run.json?.findings as unknown[] | undefined)?.length ?? 0;
    return `exit ${run.cli.exitCode} · ${run.ai.length} AI calls · ${found} findings`;
  },
});

const steps: Step[] = [
  {
    name: "repository with guides",
    async run(sim) {
      sim.repo(CHECKS_REPO, BASE_FILES);
      configureCli(sim);
      const { runInitOrRemake } = await import("../../../services/setup.ts");
      await runInitOrRemake(
        sim.options({ command: "init", repo: CHECKS_REPO }),
      );
      return `${CHECKS_REPO} · ${Object.keys(BASE_FILES).length} files`;
    },
  },
  { name: "checks text, intents and checkouts", run: prepare },
  ...ENTRIES.flatMap((entry) => ARMS.map((arm) => reviewStep(entry, arm))),
];

// ----------------------------------------------------------------- reading

const reviewCalls = (run: ReviewRun | undefined) =>
  (run?.completions ?? []).filter((call) => call.job === "review_local");

/** The first review request of a run, as the provider received it. */
const firstRequest = (run: ReviewRun | undefined) =>
  run?.ai.find((call) => call.job === "review_local")?.request;

function inputOf(sim: Sim, entry: Entry, arm: Arm): ReviewInput {
  const run = state(sim).runs.get(label(entry, arm));
  const calls = run?.completions ?? [];
  const exit = run?.cli.exitCode;
  return {
    change: entry.change.name,
    kind: entry.kind,
    ...(entry.pair ? { check: entry.pair.check } : {}),
    arm,
    finished: exit === 0 || exit === 1,
    findings: ((run?.json?.findings as FindingInput[] | undefined) ?? []).map(
      (item) => ({
        path: String(item.path ?? ""),
        lineFrom: Number(item.lineFrom),
        lineTo: Number(item.lineTo ?? item.lineFrom),
        severity: String(item.severity ?? ""),
        title: String(item.title ?? ""),
        body: String(item.body ?? ""),
      }),
    ),
    spans:
      entry.kind === "seeded" && entry.pair
        ? entry.pair.spans.map((span) =>
            resolveSpan(treeOf(entry.change), span),
          )
        : [],
    usage: {
      tokensIn: calls.reduce((total, call) => total + call.tokensIn, 0),
      tokensOut: calls.reduce((total, call) => total + call.tokensOut, 0),
      usd: calls.some((call) => call.ok && call.cost === null)
        ? null
        : calls.reduce((total, call) => total + (call.cost ?? 0), 0),
      calls: calls.length,
    },
  };
}

const allInputs = (sim: Sim) =>
  ENTRIES.flatMap((entry) => ARMS.map((arm) => inputOf(sim, entry, arm)));

// ----------------------------------------------------------------- checks

/** A check about what the scripted answers lead to. A live model gives its
 * own answers, so these are skipped with the reason. */
function scripted(sim: Sim, result: CheckResult): CheckResult {
  return sim.mode === "live"
    ? { ...result, ok: true, skipped: "live AI: the answers are the model's" }
    : result;
}

/** Lines that differ between two texts, the larger of removed and added,
 * from a longest common subsequence of lines. */
export function changedLines(a: string, b: string): number {
  const x = a.split("\n");
  const y = b.split("\n");
  const table = Array.from({ length: x.length + 1 }, () =>
    Array.from({ length: y.length + 1 }, () => 0),
  );
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      table[i]![j] =
        x[i] === y[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const common = table[0]![0]!;
  return Math.max(x.length - common, y.length - common);
}

/** Where a seeded change and its twin differ, as found, against what the
 * pair declares. */
export function pairProblems(pair: Pair): string[] {
  const problems: string[] = [];
  const a = treeOf(pair.seeded);
  const b = treeOf(pair.fixed);
  for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const lines = changedLines(a[path] ?? "", b[path] ?? "");
    const allowed = pair.differs[path] ?? 0;
    if (lines > allowed) {
      problems.push(
        `${pair.check} ${path}: ${lines} lines differ, ${allowed} declared`,
      );
    }
    if (allowed > 0 && lines === 0) {
      problems.push(`${pair.check} ${path}: declared to differ, but the same`);
    }
  }
  if (pair.check === "C7" && pair.seeded.intent === pair.fixed.intent) {
    problems.push("C7: the intents must differ, the diff is the same");
  }
  for (const span of pair.spans) {
    try {
      resolveSpan(a, span);
    } catch (error) {
      problems.push(`${pair.check} ${(error as Error).message}`);
    }
  }
  return problems;
}

function flowChecks(sim: Sim): CheckResult[] {
  const s = state(sim);
  const block = checksBlock();
  const runs = ENTRIES.flatMap((entry) =>
    ARMS.map((arm) => ({ entry, arm, run: s.runs.get(label(entry, arm)) })),
  );
  const exits = runs.map(({ run }) => run?.cli.exitCode);

  const textProblems: string[] = [];
  for (const { entry, arm, run } of runs) {
    const calls = reviewCalls(run);
    if (!calls.length)
      textProblems.push(`${label(entry, arm)}: no review call`);
    for (const call of calls) {
      const hasText = call.system.includes(block);
      const mentions = call.system.includes("REVIEW CHECKS");
      if (arm === "checks" && !hasText) {
        textProblems.push(`${label(entry, arm)}: the checks text is missing`);
      }
      if (arm === "baseline" && mentions) {
        textProblems.push(`${label(entry, arm)}: holds the checks`);
      }
    }
  }

  const sameProblems: string[] = [];
  const escaped = JSON.stringify(block).slice(1, -1);
  for (const entry of ENTRIES) {
    const base = s.runs.get(label(entry, "baseline"));
    const withChecks = s.runs.get(label(entry, "checks"));
    const plain = JSON.stringify(firstRequest(base) ?? null);
    const stripped = JSON.stringify(firstRequest(withChecks) ?? null).replace(
      escaped,
      "",
    );
    const [one] = reviewCalls(base);
    const [two] = reviewCalls(withChecks);
    if (plain === "null" || plain !== stripped) {
      sameProblems.push(`${entry.change.name}: the requests differ`);
    } else if (
      two?.system !== `${one?.system}${block}` ||
      one?.firstUser !== two?.firstUser
    ) {
      sameProblems.push(
        `${entry.change.name}: the system or user prompt differs`,
      );
    }
  }

  const pairs = PAIRS.flatMap(pairProblems);

  // The inherited check reads calls with one first message as one
  // conversation. Here the two arms share that message on purpose, so this
  // check groups the calls by review instead.
  const drifting = runs
    .filter(
      ({ run }) =>
        new Set(reviewCalls(run).map((call) => call.system)).size > 1,
    )
    .map(({ entry, arm }) => label(entry, arm));

  const fakeProblems: string[] = [];
  for (const input of allInputs(sim).filter(
    (item) => item.arm === "baseline",
  )) {
    const tally = tallyArm([input], "baseline");
    const caught = input.check ? tally.catches[input.check] : 0;
    if (
      input.kind === "seeded" &&
      (input.findings.length !== 1 || caught !== 1)
    ) {
      fakeProblems.push(
        `${input.change}: ${input.findings.length} findings, caught ${caught}`,
      );
    }
    if (input.kind !== "seeded" && input.findings.length !== 0) {
      fakeProblems.push(`${input.change}: ${input.findings.length} findings`);
    }
  }

  const reviews = allInputs(sim);
  const baseline = tallyArm(reviews, "baseline");
  const checks = tallyArm(reviews, "checks");
  const nonZero = (values: Record<string, number>) =>
    Object.fromEntries(Object.entries(values).filter(([, value]) => value > 0));
  const sum = (values: Record<string, number>) =>
    Object.values(values).reduce((total, value) => total + value, 0);
  const got = {
    baseline: {
      catches: sum(baseline.catches),
      falseFindings: sum(baseline.falseByChange),
      p3: sum(baseline.p3ByChange),
      other: baseline.other,
    },
    checks: {
      catches: checks.catches,
      falseByChange: nonZero(checks.falseByChange),
      p3: sum(checks.p3ByChange),
      falseTagged: nonZero(checks.falseTagged),
      falseUntagged: checks.falseUntagged,
      taggedCatches: nonZero(checks.taggedCatches),
      other: checks.other,
      lowAtSeed: nonZero(checks.lowAtSeed),
    },
  };
  const summary = checkRuns(baseline, checks)
    .map(
      (row) =>
        `${row.check} ${row.baselineCatches}/${row.checksCatches}/${row.falseWithTag}`,
    )
    .join(" ");

  return [
    check(
      "every review ran to its end",
      runs.length === ENTRIES.length * 2 &&
        exits.every((code) => code === 0 || code === 1),
      `${runs.length} reviews · exits ${[...new Set(exits)].join(", ")}`,
    ),
    check(
      "the checks text is in the system prompt of every checks-arm request, and in no baseline request",
      textProblems.length === 0,
      textProblems.join(", ") ||
        `${runs.length} reviews, ${block.length} characters added`,
    ),
    check(
      "apart from the checks text, both arms send the same first request for each change",
      sameProblems.length === 0,
      sameProblems.join(", ") || `${ENTRIES.length} changes compared`,
    ),
    check(
      "each seeded change and its twin differ only in the declared lines, and every seeded span points at a line",
      pairs.length === 0,
      pairs.join(", ") || `${PAIRS.length} pairs`,
    ),
    scripted(
      sim,
      check(
        "the fake reviewer finds one catch on each seeded change and nothing on a twin or a clean change",
        fakeProblems.length === 0,
        fakeProblems.join(", ") ||
          `${CHECK_IDS.length} seeded, ${ENTRIES.length - CHECK_IDS.length} controls`,
      ),
    ),
    scripted(
      sim,
      check(
        "the scores count the scripted catches, the miss, the P3 catch, the other finding and the false findings with and without a tag",
        JSON.stringify(got) === JSON.stringify(EXPECTED),
        `${summary} · ${JSON.stringify(got)}`,
      ),
    ),
    check(
      "nothing is written to GitHub",
      sim.github.writes.length === 0,
      `${sim.github.writes.length} writes`,
    ),
    check(
      "each review keeps one system prompt over all its rounds",
      drifting.length === 0,
      drifting.join(", ") ||
        `${runs.length} reviews, ${runs.reduce((total, { run }) => total + reviewCalls(run).length, 0)} requests`,
    ),
  ];
}

// ----------------------------------------------------------------- scores

function scores(sim: Sim) {
  const s = state(sim);
  const one = (name: string, arm: Arm) =>
    reviewCalls(s.runs.get(`review ${name}, ${arm}`))[0]?.system.length ?? 0;
  const first = ENTRIES[0]!.change.name;
  const used = [...s.runs.values()].filter(
    (run) => (run.json?.codegraph as Json | undefined)?.state === "used",
  ).length;
  return reviewScores({
    reviews: allInputs(sim),
    fakeAi: sim.mode === "fake",
    system: { baseline: one(first, "baseline"), checks: one(first, "checks") },
    codegraph: { used, reason: s.codegraphReason },
  });
}

export default defineFlow({
  name: "review-checks",
  description:
    "seven seeded changes, their fixed twins and three clean changes, each reviewed with and without the review checks of issue 80, scored for catches and noise",
  ai: AI,
  steps,
  checks: flowChecks,
  scores,
  skipInherited: {
    "one system prompt per conversation":
      "the two arms send the same first message under two system prompts on purpose, so the inherited check reads each pair as one conversation. The flow checks each review on its own instead.",
  },
});
