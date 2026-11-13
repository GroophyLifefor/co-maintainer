/** CLI pull request review remembers its findings between runs.
 *
 * `co-maintainer review owner/repo N` used to call every finding new on every
 * run. It now stores each run in the cache, keyed by repository and pull
 * request number, and the next run shows `closed`, `open` and `new`. This flow
 * runs the review again and again on simulated pull requests, with the author
 * pushing between runs, and checks what the product printed, what it sent the
 * model, what it stored and what it did not do.
 *
 * The model is a small reviewer: it reports a problem when the diff it was
 * sent holds it, and judges each earlier finding by the hint the product gave
 * it, so what it answers moves with what the product sent. The two problems:
 * a divide that does not guard a zero divisor (blocking, in `src/math.ts`) and
 * a percent helper that rounds with `toFixed` (not blocking, `src/format.ts`).
 *
 * Built on the CLI review flow's exports and the local review flow's reader of
 * the carry-over section. It does not edit either. */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AiCall as FakeCall, AiRule } from "../fake_ai.ts";
import {
  type CheckResult,
  check,
  type CliRun,
  defineFlow,
  type Score,
  scriptedCheck,
  type Sim,
  type Step,
} from "../flow.ts";
import type { SimPull } from "../github.ts";
import {
  CLI_PR_REPO,
  cliPrAi,
  guidesStep,
  githubCalls,
  lineOf,
  mainFiles,
  openChangePull,
  parseJsonOutput,
  reviewCli,
  reviewCompletions,
  reviewWithSummary,
  runsOf,
  symbolFinding,
} from "./cli_pr.ts";
import {
  carryEntries,
  type Checkout,
  configureCli,
  makeCheckout,
  NO_CODEGRAPH,
  promptDiff,
  runReview,
} from "./local.ts";

type Json = Record<string, unknown>;

// ------------------------------------------------------------ the pull request

const MATH_BAD = mainFiles()["src/math.ts"]!;
const MATH_FIXED = mainFiles(true)["src/math.ts"]!;
const FORMAT_BAD = mainFiles()["src/format.ts"]!;
const FORMAT_FIXED = FORMAT_BAD.replace(
  "(clamp(ratio, 0, 1) * 100).toFixed(digits)",
  "Math.round(clamp(ratio, 0, 1) * 100)",
);
const MATH_PATH = "src/math.ts";
const FORMAT_PATH = "src/format.ts";
const MATH_LINE = lineOf(MATH_BAD, "return a / b;");
const FORMAT_LINE = lineOf(FORMAT_BAD, ".toFixed(digits)");
const MATH_TITLE = "divide does not guard a zero divisor";
const MATH_BODY =
  "A zero divisor returns Infinity, so the caller gets no error.";
const FORMAT_TITLE = "formatPercent rounds with toFixed";
const FORMAT_BODY =
  "The helper rounds with toFixed, which differs from Math.round.";

/** The two files every pull request in this flow changes, both with their
 * problem. */
const BAD_FILES = { [MATH_PATH]: MATH_BAD, [FORMAT_PATH]: FORMAT_BAD };

/** A problem the reviewer looks for: the line of the diff that holds it, or
 * undefined when the diff does not. */
type Problem = {
  path: string;
  line(added: Map<number, string>): number | undefined;
  finding(line: number): Json;
};

const firstLine =
  (present: (text: string) => boolean, absent?: (text: string) => boolean) =>
  (added: Map<number, string>): number | undefined => {
    const texts = [...added.values()];
    if (absent && texts.some(absent)) return undefined;
    return [...added].find(([, text]) => present(text))?.[0];
  };

const PROBLEMS: Problem[] = [
  {
    path: MATH_PATH,
    // The guard is what fixes it: with it in the diff the problem is gone.
    line: firstLine(
      (text) => text.includes("return a / b;"),
      (text) => text.includes("RangeError"),
    ),
    finding: (line) =>
      symbolFinding({
        path: MATH_PATH,
        line,
        title: MATH_TITLE,
        body: MATH_BODY,
        severity: "P1",
        blocking: true,
        symbol: "divide",
      }),
  },
  {
    path: FORMAT_PATH,
    line: firstLine((text) => text.includes(".toFixed(digits)")),
    finding: (line) =>
      symbolFinding({
        path: FORMAT_PATH,
        line,
        title: FORMAT_TITLE,
        body: FORMAT_BODY,
        severity: "P3",
        symbol: "formatPercent",
      }),
  },
];

/** The reviewer. It reports each problem the diff holds that no earlier
 * finding covers, and answers each earlier finding from its hint: a file the
 * product says is unchanged stays open, and any other is open while the diff
 * still holds the problem and closed when it does not. */
function reviewerReply(call: FakeCall) {
  const diff = promptDiff(call.prompt);
  const entries = carryEntries(call.prompt);
  const lineOf = (problem: Problem) =>
    problem.line(diff.get(problem.path) ?? new Map());
  const previousFindings = entries.map((entry) => {
    const problem = PROBLEMS.find((item) => item.path === entry.path);
    const unchanged = entry.hint.startsWith("file unchanged");
    const line = problem ? lineOf(problem) : undefined;
    if (!problem || (!unchanged && line === undefined)) {
      return { id: entry.label, state: "closed" };
    }
    return {
      id: entry.label,
      state: "open",
      path: entry.path,
      lineFrom: line ?? entry.from,
      lineTo: (line ?? entry.from) + (entry.to - entry.from),
    };
  });
  const covered = new Set(entries.map((entry) => entry.path));
  const findings = PROBLEMS.flatMap((problem) => {
    const line = lineOf(problem);
    return line === undefined || covered.has(problem.path)
      ? []
      : [problem.finding(line)];
  });
  return {
    json: {
      findings,
      ...(previousFindings.length ? { previousFindings } : {}),
    },
  };
}

const REVIEWER: AiRule = {
  name: "reviewer for the carry-over flow",
  job: /^review_(pull_request|pull_request_retry|local)$/,
  reply: reviewerReply,
};

// --------------------------------------------------------------- what is stored

type Stored = {
  files: { path: string }[];
  visiblePaths: string[];
  findings: {
    id: string;
    path: string | null;
    lineFrom: number | null;
    title: string;
    anchorText: string | null;
    severity: string;
  }[];
  guideBuiltAt: string | null;
  headSha?: string | null;
};

/** The cache namespace and key of a pull request's stored run. */
const NAMESPACE = "local-review";
const storeKey = (number: number) => `${CLI_PR_REPO}\0pull-request\0${number}`;

function cacheRows(sim: Sim): { key: string; value: string }[] {
  if (!existsSync(sim.paths.cacheDb)) return [];
  const database = new DatabaseSync(sim.paths.cacheDb, { readOnly: true });
  try {
    return (
      database
        .prepare(
          "SELECT cache_key AS key, value FROM cache WHERE namespace = ?",
        )
        .all(NAMESPACE) as { key: string; value: string }[]
    ).filter((row) => row.key.startsWith(`${CLI_PR_REPO}\0`));
  } finally {
    database.close();
  }
}

function storedRun(sim: Sim, number: number): Stored | null {
  const row = cacheRows(sim).find((item) => item.key === storeKey(number));
  return row ? (JSON.parse(row.value) as Stored) : null;
}

// ----------------------------------------------------------- pull requests, steps

type Case = "human" | "json" | "github" | "four" | "fresh" | "guide" | "force";

const TITLES: Record<Case, string> = {
  human: "Carry-over: human output",
  json: "Carry-over: JSON output",
  github: "Carry-over: GitHub output",
  four: "Carry-over: four runs",
  fresh: "Carry-over: --fresh",
  guide: "Carry-over: guide rebuilt",
  force: "Carry-over: force-push",
};

function pullOf(sim: Sim, name: Case): SimPull {
  const pull = (sim.state.pulls as Record<string, SimPull> | undefined)?.[name];
  if (!pull) throw new Error(`the flow has no pull request ${name}`);
  return pull;
}

/** What each step stored, by step name, read right after the run. */
function storedBy(sim: Sim): Record<string, Stored | null> {
  return ((sim.state.stored as Record<string, Stored | null> | undefined) ??=
    {});
}

/** The cache keys of this repository after each step, by step name. */
function keysBy(sim: Sim): Record<string, string[]> {
  return ((sim.state.keys as Record<string, string[]> | undefined) ??= {});
}

/** The head each run reviewed, by step name. */
function headsBy(sim: Sim): Record<string, string> {
  return ((sim.state.heads as Record<string, string> | undefined) ??= {});
}

/** One review of a pull request, with what it stored and which head it read. */
function reviewStep(
  name: string,
  which: Case,
  extra: string[] = ["--json", NO_CODEGRAPH],
  before?: (sim: Sim, pull: SimPull) => void,
): Step {
  return {
    name,
    async run(sim) {
      const pull = pullOf(sim, which);
      before?.(sim, pull);
      headsBy(sim)[name] = pull.headSha;
      const run = await reviewCli(sim, pull.number, extra);
      storedBy(sim)[name] = storedRun(sim, pull.number);
      keysBy(sim)[name] = cacheRows(sim).map((row) => row.key);
      return `#${pull.number} · exit ${run.exitCode}`;
    },
  };
}

const pushMath = (sim: Sim, pull: SimPull) =>
  sim.github.push(pull, { [MATH_PATH]: MATH_FIXED }, "Guard a zero divisor");
const pushFormat = (sim: Sim, pull: SimPull) =>
  sim.github.push(pull, { [FORMAT_PATH]: FORMAT_FIXED }, "Round with Math");

const S = {
  open: "open the pull requests",
  humanOne: "human run 1",
  humanTwo: "human run 2, after a fix for the percent helper",
  jsonOne: "json run 1",
  jsonTwo: "json run 2, after a fix for the percent helper",
  githubOne: "github output run 1",
  githubTwo: "github output run 2, after a fix for the percent helper",
  fourOne: "four runs, run 1",
  fourTwo: "four runs, run 2 on the same head",
  fourThree: "four runs, run 3 after a fix for divide",
  fourFour: "four runs, run 4 after a fix for the percent helper",
  freshOne: "fresh, run 1",
  freshTwo: "fresh, run 2 with --fresh after a fix for divide",
  guideOne: "guide rebuilt, run 1",
  rebuild: "guide rebuilt between runs",
  guideTwo: "guide rebuilt, run 2",
  forceOne: "force-push, run 1",
  forceTwo: "force-push, run 2 after the branch was rewritten",
  local: "a local review of the same repository",
  clear: "clear the repository and its cache",
} as const;

const steps: Step[] = [
  guidesStep,
  {
    name: S.open,
    run(sim) {
      const pulls: Record<string, SimPull> = {};
      for (const name of Object.keys(TITLES) as Case[]) {
        pulls[name] = openChangePull(sim, {
          title: TITLES[name],
          body: "",
          files: BAD_FILES,
        });
      }
      sim.state.pulls = pulls;
      return Object.values(pulls)
        .map((pull) => `#${pull.number}`)
        .join(" ");
    },
  },
  // Two findings, one blocking. The author fixes the other one.
  reviewStep(S.humanOne, "human", [NO_CODEGRAPH]),
  reviewStep(S.humanTwo, "human", [NO_CODEGRAPH], pushFormat),
  reviewStep(S.jsonOne, "json"),
  reviewStep(S.jsonTwo, "json", undefined, pushFormat),
  reviewStep(S.githubOne, "github", [NO_CODEGRAPH]),
  {
    name: S.githubTwo,
    async run(sim) {
      const pull = pullOf(sim, "github");
      pushFormat(sim, pull);
      const { run, summary } = await reviewWithSummary(sim, pull.number, [
        NO_CODEGRAPH,
      ]);
      sim.state.githubSummary = summary;
      return `exit ${run.exitCode}`;
    },
  },
  // The four runs: the same head again, a fix for each file in turn.
  reviewStep(S.fourOne, "four"),
  reviewStep(S.fourTwo, "four"),
  reviewStep(S.fourThree, "four", undefined, pushMath),
  reviewStep(S.fourFour, "four", undefined, pushFormat),
  // Starting over.
  reviewStep(S.freshOne, "fresh"),
  reviewStep(
    S.freshTwo,
    "fresh",
    ["--json", NO_CODEGRAPH, "--fresh"],
    pushMath,
  ),
  reviewStep(S.guideOne, "guide"),
  {
    name: S.rebuild,
    async run(sim) {
      const { runInitOrRemake } = await import("../../../services/setup.ts");
      await runInitOrRemake(
        sim.options({ command: "remake", repo: CLI_PR_REPO }),
      );
    },
  },
  // The author also pushes, so a run that kept the carry-over would compare
  // the heads, and one that started fresh for the guide would not.
  reviewStep(S.guideTwo, "guide", undefined, pushFormat),
  reviewStep(S.forceOne, "force"),
  reviewStep(S.forceTwo, "force", undefined, (sim, pull) => {
    // The author rebases: one new commit straight on the base, with the
    // divide guarded. The old head is no longer on the branch.
    sim.github.forcePush(
      pull,
      { [MATH_PATH]: MATH_FIXED, [FORMAT_PATH]: FORMAT_BAD },
      "Rewrite the branch",
    );
  }),
  // A local review of the same repository: its carry-over is its own.
  {
    name: S.local,
    async run(sim) {
      configureCli(sim);
      const checkout: Checkout = makeCheckout(sim, {
        name: "carry-local",
        branch: "feature/carry",
        committed: BAD_FILES,
      });
      sim.state.localBefore = Object.fromEntries(
        cacheRows(sim).map((row) => [row.key, row.value]),
      );
      const run = await runReview(sim, checkout, "local", [
        "--json",
        NO_CODEGRAPH,
      ]);
      sim.state.localRun = run.cli;
      sim.state.afterLocal = cacheRows(sim);
      return `exit ${run.cli.exitCode}`;
    },
  },
  {
    name: S.clear,
    async run(sim) {
      sim.state.rowsBeforeClear = cacheRows(sim).length;
      const run = await sim.cli(["clear", CLI_PR_REPO, "--include-cache"]);
      return `exit ${run.exitCode}`;
    },
  },
];

// ------------------------------------------------------------------ readers

const firstRun = (sim: Sim, step: string): CliRun | undefined =>
  runsOf(sim, step)[0];

const promptOf = (sim: Sim, step: string): string =>
  reviewCompletions(sim, step)[0]?.firstUser ?? "";

type Row = {
  state?: string;
  path?: string | null;
  closeReason?: string | null;
  blocking?: boolean;
  id?: string;
};

function rowsOf(run: CliRun | undefined): Row[] {
  return (parseJsonOutput(run?.stdout ?? "")?.findings ?? []) as Row[];
}

function summaryOf(run: CliRun | undefined): Record<string, number> {
  return (parseJsonOutput(run?.stdout ?? "")?.summary ?? {}) as Record<
    string,
    number
  >;
}

/** `path: state` of a run's findings, sorted, for a detail line. */
function statesText(run: CliRun | undefined): string {
  return (
    rowsOf(run)
      .map((row) => `${row.path} ${row.state}`)
      .sort()
      .join(", ") || "no findings"
  );
}

const stateOf = (run: CliRun | undefined, path: string): string | undefined =>
  rowsOf(run).find((row) => row.path === path)?.state;

/** The summary as `N new · N open · N closed` for a run's JSON. */
function counts(run: CliRun | undefined): string {
  const summary = summaryOf(run);
  return `${summary.new} new · ${summary.open} open · ${summary.closed} closed · ${summary.blocking} blocking`;
}

/** The paths of the DIFF section's files in a review prompt. */
const diffPaths = (prompt: string): string[] => [...promptDiff(prompt).keys()];

/** The paths a prompt lists as unchanged since the last review. */
function unchangedListed(prompt: string): string[] {
  const start = prompt.indexOf("UNCHANGED SINCE LAST REVIEW");
  if (start < 0) return [];
  return [...prompt.slice(start).matchAll(/^- (.+)$/gm)].map(
    (match) => match[1]!,
  );
}

const hasCarry = (prompt: string): boolean =>
  prompt.includes("PREVIOUS FINDINGS");

const log = (run: CliRun | undefined): string => run?.stderr ?? "";

/** The model's answer to a review call, parsed, or undefined. */
function answerOf(run: CliRun): Json | undefined {
  const call = run.ai().find((item) => item.job === "review_pull_request");
  const content = (
    (call?.response as Json | undefined)?.choices as Json[] | undefined
  )?.[0]?.message as Json | undefined;
  try {
    return JSON.parse(String(content?.content ?? "")) as Json;
  } catch {
    return undefined;
  }
}

/** A check about what the scripted model's answers must lead to. */
function scripted(
  sim: Sim,
  name: string,
  ok: boolean,
  detail: string,
): CheckResult {
  return scriptedCheck(sim, name, ok, detail, "the answers are the model's");
}

// ------------------------------------------------------------------- checks

function flowChecks(sim: Sim): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (...items: CheckResult[]) => results.push(...items);
  const stored = storedBy(sim);
  const heads = headsBy(sim);
  const human = pullOf(sim, "human");
  const json = pullOf(sim, "json");
  const four = pullOf(sim, "four");
  const force = pullOf(sim, "force");

  // ---- run 1 and run 2 in the terminal
  const h1 = firstRun(sim, S.humanOne);
  const h2 = firstRun(sim, S.humanTwo);
  const out1 = h1?.stdout ?? "";
  const out2 = h2?.stdout ?? "";
  add(
    scripted(
      sim,
      "run 1 of a pull request calls both findings new and exits 1 on the blocking one",
      h1?.exitCode === 1 &&
        out1.includes("New (2)") &&
        !out1.includes("Closed (") &&
        !out1.includes("Still open (") &&
        out1.includes("Summary: 2 new · 0 open · 0 closed · 1 blocking"),
      `exit ${h1?.exitCode}`,
    ),
    scripted(
      sim,
      "run 2 prints one closed and one still open finding and nothing as new",
      out2.includes("Closed (1)") &&
        out2.includes(`✓ ${FORMAT_PATH}:${FORMAT_LINE}`) &&
        out2.includes("Still open (1)") &&
        out2.includes(`• ${MATH_PATH}:${MATH_LINE}  [P1 · blocking]`) &&
        !out2.includes("New (") &&
        out2.includes("Summary: 0 new · 1 open · 1 closed · 1 blocking"),
      out2.split("\n").find((line) => line.startsWith("Summary:")) ??
        "no summary",
    ),
    scripted(
      sim,
      "run 2 exits 1 because the blocking finding is still open",
      h2?.exitCode === 1,
      `exit ${h2?.exitCode}`,
    ),
  );

  // ---- run 2 in JSON
  const j1 = firstRun(sim, S.jsonOne);
  const j2 = firstRun(sim, S.jsonTwo);
  const jsonDoc = parseJsonOutput(j2?.stdout ?? "");
  add(
    scripted(
      sim,
      "run 2 in JSON has one closed, one open and no new finding, and exits 1",
      j2?.exitCode === 1 &&
        stateOf(j2, FORMAT_PATH) === "closed" &&
        stateOf(j2, MATH_PATH) === "open" &&
        rowsOf(j2).find((row) => row.path === MATH_PATH)?.blocking === true &&
        counts(j2) === "0 new · 1 open · 1 closed · 1 blocking" &&
        rowsOf(j2).length === 2,
      `${counts(j2)} · ${statesText(j2)}`,
    ),
    check(
      "run 2 in JSON is one document with no warning",
      jsonDoc?.ok === true &&
        Array.isArray(jsonDoc.warnings) &&
        (jsonDoc.warnings as unknown[]).length === 0 &&
        (jsonDoc.subject as Json | undefined)?.prNumber === json.number,
      `ok ${String(jsonDoc?.ok)}`,
    ),
    scripted(
      sim,
      "run 1 in JSON has two new findings and no open or closed one",
      counts(j1) === "2 new · 0 open · 0 closed · 1 blocking" &&
        rowsOf(j1).every((row) => row.state === "new"),
      counts(j1),
    ),
  );

  // ---- run 2 as GitHub annotations
  const github2 = firstRun(sim, S.githubTwo);
  const summary = String(sim.state.githubSummary ?? "");
  add(
    scripted(
      sim,
      "run 2 with --output=github annotates the open finding, not the closed one, and counts both",
      github2?.exitCode === 1 &&
        (github2?.stdout ?? "").includes(
          `::error file=${MATH_PATH},line=${MATH_LINE}`,
        ) &&
        !(github2?.stdout ?? "").includes(FORMAT_PATH) &&
        summary.includes("**Summary:** 0 new · 1 open · 1 closed · 1 blocking"),
      summary.split("\n").find((line) => line.includes("Summary")) ??
        "no summary",
    ),
  );

  // ---- what the model is sent in run 2
  const p1 = promptOf(sim, S.humanOne);
  const p2 = promptOf(sim, S.humanTwo);
  const entries2 = carryEntries(p2);
  add(
    check(
      "run 1 sends no carry-over section and both changed files",
      !hasCarry(p1) &&
        unchangedListed(p1).length === 0 &&
        diffPaths(p1).sort().join() === [FORMAT_PATH, MATH_PATH].join(),
      diffPaths(p1).join(", "),
    ),
    scripted(
      sim,
      "run 2 sends the carry section with both earlier findings, each with its text",
      hasCarry(p2) &&
        entries2.length === 2 &&
        p2.includes(MATH_BODY) &&
        p2.includes(FORMAT_BODY),
      `${entries2.length} entries: ${entries2.map((entry) => `${entry.label} ${entry.path}:${entry.from}`).join(", ")}`,
    ),
    scripted(
      sim,
      "run 2 sends only the changed file as diff and lists the other as unchanged",
      diffPaths(p2).join() === FORMAT_PATH &&
        unchangedListed(p2).join() === MATH_PATH &&
        p2.includes("Math.round(clamp(ratio, 0, 1) * 100)") &&
        !p2.includes("return a / b;\n"),
      `diff: ${diffPaths(p2).join()} · unchanged: ${unchangedListed(p2).join()}`,
    ),
    scripted(
      sim,
      "run 2 asks about a file that did not change with the hint that says so",
      entries2.find((entry) => entry.path === MATH_PATH)?.hint ===
        "file unchanged since the last review, the fix may be in another file" &&
        entries2.find((entry) => entry.path === FORMAT_PATH)?.hint !==
          undefined &&
        !entries2
          .find((entry) => entry.path === FORMAT_PATH)!
          .hint.startsWith("file unchanged"),
      entries2.map((entry) => `${entry.path}: ${entry.hint}`).join(" | "),
    ),
    scripted(
      sim,
      "run 2 is one more AI call with the same system prompt",
      reviewCompletions(sim, S.humanTwo).length === 1 &&
        reviewCompletions(sim, S.humanTwo)[0]?.system ===
          reviewCompletions(sim, S.humanOne)[0]?.system,
      "the guides did not change",
    ),
    check(
      "run 2 sends the same system prompt as run 1",
      reviewCompletions(sim, S.humanTwo).length > 0 &&
        reviewCompletions(sim, S.humanTwo).every(
          (call) =>
            call.system === reviewCompletions(sim, S.humanOne)[0]?.system,
        ),
      "the guides did not change",
    ),
  );

  // ---- four runs
  const f1 = firstRun(sim, S.fourOne);
  const f2 = firstRun(sim, S.fourTwo);
  const f3 = firstRun(sim, S.fourThree);
  const f4 = firstRun(sim, S.fourFour);
  const fp2 = promptOf(sim, S.fourTwo);
  const fp3 = promptOf(sim, S.fourThree);
  const fp4 = promptOf(sim, S.fourFour);
  add(
    scripted(
      sim,
      "four runs: run 1 has two new findings",
      counts(f1) === "2 new · 0 open · 0 closed · 1 blocking" &&
        f1?.exitCode === 1,
      counts(f1),
    ),
    scripted(
      sim,
      "four runs: the same head again keeps both findings open and exits 1",
      counts(f2) === "0 new · 2 open · 0 closed · 1 blocking" &&
        f2?.exitCode === 1,
      counts(f2),
    ),
    scripted(
      sim,
      "four runs: the same head again sends the model no file, only the earlier findings",
      diffPaths(fp2).length === 0 &&
        unchangedListed(fp2).sort().join() ===
          [FORMAT_PATH, MATH_PATH].join() &&
        carryEntries(fp2).length === 2,
      `diff: ${diffPaths(fp2).length} files · unchanged: ${unchangedListed(fp2).join()}`,
    ),
    scripted(
      sim,
      "four runs: a fix for divide closes it and leaves the percent helper open, exit 0",
      stateOf(f3, MATH_PATH) === "closed" &&
        stateOf(f3, FORMAT_PATH) === "open" &&
        counts(f3) === "0 new · 1 open · 1 closed · 0 blocking" &&
        f3?.exitCode === 0,
      `${statesText(f3)} · exit ${f3?.exitCode}`,
    ),
    scripted(
      sim,
      "four runs: the fixed file is judged with its diff, not as unchanged, even after a run that skipped it",
      diffPaths(fp3).join() === MATH_PATH &&
        carryEntries(fp3).find((entry) => entry.path === MATH_PATH) !==
          undefined &&
        !carryEntries(fp3)
          .find((entry) => entry.path === MATH_PATH)!
          .hint.startsWith("file unchanged") &&
        carryEntries(fp3).find((entry) => entry.path === FORMAT_PATH)?.hint ===
          "file unchanged since the last review, the fix may be in another file",
      carryEntries(fp3)
        .map((entry) => `${entry.path}: ${entry.hint}`)
        .join(" | "),
    ),
    scripted(
      sim,
      "four runs: a fix for the percent helper closes it, nothing is left open, exit 0",
      stateOf(f4, FORMAT_PATH) === "closed" &&
        counts(f4) === "0 new · 0 open · 1 closed · 0 blocking" &&
        f4?.exitCode === 0,
      `${statesText(f4)} · exit ${f4?.exitCode}`,
    ),
    scripted(
      sim,
      "four runs: run 4 asks only about the finding still open",
      carryEntries(fp4).length === 1 &&
        carryEntries(fp4)[0]?.path === FORMAT_PATH,
      carryEntries(fp4)
        .map((entry) => entry.path)
        .join(),
    ),
  );

  // ---- what is stored
  const s1 = stored[S.fourOne];
  const s2 = stored[S.fourTwo];
  const s3 = stored[S.fourThree];
  const s4 = stored[S.fourFour];
  const key = JSON.stringify(storeKey(four.number));
  add(
    check(
      "the stored run is one row in the local-review cache, keyed by repository and pull request number",
      (keysBy(sim)[S.fourOne] ?? []).includes(storeKey(four.number)) &&
        s1 !== null,
      `namespace ${NAMESPACE}, key ${key}`,
    ),
    scripted(
      sim,
      "the stored run holds the findings, the files, the seen paths, the guide time and the head",
      s1 !== null &&
        s1.headSha === heads[S.fourOne] &&
        s1.findings.length === 2 &&
        s1.findings.every(
          (row) =>
            row.id.length > 0 &&
            row.path !== null &&
            (row.lineFrom ?? 0) > 0 &&
            (row.anchorText ?? "").length > 0,
        ) &&
        s1.files
          .map((file) => file.path)
          .sort()
          .join() === [FORMAT_PATH, MATH_PATH].join() &&
        s1.visiblePaths.slice().sort().join() ===
          [FORMAT_PATH, MATH_PATH].join() &&
        typeof s1.guideBuiltAt === "string",
      s1
        ? `head ${s1.headSha?.slice(0, 7)}, ${s1.findings.length} findings, ${s1.files.length} files, guide ${s1.guideBuiltAt}`
        : "nothing stored",
    ),
    check(
      "the stored run holds the files, the seen paths, the guide time and the head",
      s1 !== null &&
        s1.headSha === heads[S.fourOne] &&
        s1.files
          .map((file) => file.path)
          .sort()
          .join() === [FORMAT_PATH, MATH_PATH].join() &&
        s1.visiblePaths.slice().sort().join() ===
          [FORMAT_PATH, MATH_PATH].join() &&
        typeof s1.guideBuiltAt === "string",
      s1
        ? `head ${s1.headSha?.slice(0, 7)}, ${s1.files.length} files, guide ${s1.guideBuiltAt}`
        : "nothing stored",
    ),
    scripted(
      sim,
      "the same head again keeps both findings, the head and every seen path",
      s2 !== null &&
        s2.headSha === s1?.headSha &&
        s2.findings.length === 2 &&
        s2.visiblePaths.slice().sort().join() ===
          [FORMAT_PATH, MATH_PATH].join(),
      s2
        ? `visible after a run that sent no file: ${s2.visiblePaths.join()}`
        : "nothing stored",
    ),
    check(
      "the same head again keeps the head and every seen path",
      s2 !== null &&
        s2.headSha === s1?.headSha &&
        s2.visiblePaths.slice().sort().join() ===
          [FORMAT_PATH, MATH_PATH].join(),
      s2
        ? `visible after a run that sent no file: ${s2.visiblePaths.join()}`
        : "nothing stored",
    ),
    scripted(
      sim,
      "a fix moves the stored head, drops the closed finding and still counts both files as seen",
      s3 !== null &&
        s3.headSha === heads[S.fourThree] &&
        s3.headSha !== s2?.headSha &&
        s3.findings.map((row) => row.path).join() === FORMAT_PATH &&
        s3.visiblePaths.slice().sort().join() ===
          [FORMAT_PATH, MATH_PATH].join(),
      s3
        ? `findings ${s3.findings.map((row) => row.path).join()}, visible ${s3.visiblePaths.join()}`
        : "nothing stored",
    ),
    check(
      "a fix moves the stored head and still counts both files as seen",
      s3 !== null &&
        s3.headSha === heads[S.fourThree] &&
        s3.headSha !== s2?.headSha &&
        s3.visiblePaths.slice().sort().join() ===
          [FORMAT_PATH, MATH_PATH].join(),
      s3
        ? `head ${s3.headSha?.slice(0, 7)}, visible ${s3.visiblePaths.join()}`
        : "nothing stored",
    ),
    scripted(
      sim,
      "when everything is closed the stored run has no finding",
      s4 !== null &&
        s4.findings.length === 0 &&
        s4.headSha === heads[S.fourFour],
      s4 ? `${s4.findings.length} findings` : "nothing stored",
    ),
    check(
      "when everything is closed the stored run has the new head",
      s4 !== null && s4.headSha === heads[S.fourFour],
      s4 ? `head ${s4.headSha?.slice(0, 7)}` : "nothing stored",
    ),
  );

  // ---- starting over
  const fr1 = firstRun(sim, S.freshOne);
  const fr2 = firstRun(sim, S.freshTwo);
  const frp = promptOf(sim, S.freshTwo);
  const frS1 = stored[S.freshOne];
  const frS2 = stored[S.freshTwo];
  add(
    check(
      "--fresh sends no carry section and every changed file, and lists none as unchanged",
      !hasCarry(frp) &&
        unchangedListed(frp).length === 0 &&
        diffPaths(frp).sort().join() === [FORMAT_PATH, MATH_PATH].join(),
      `diff: ${diffPaths(frp).join()}`,
    ),
    scripted(
      sim,
      "--fresh calls what the model finds new and keeps nothing open or closed",
      counts(fr2) === "1 new · 0 open · 0 closed · 0 blocking" &&
        stateOf(fr2, FORMAT_PATH) === "new" &&
        fr2?.exitCode === 0 &&
        fr1?.exitCode === 1,
      `${counts(fr2)} · exit ${fr2?.exitCode}`,
    ),
    scripted(
      sim,
      "--fresh stores this run: its one finding, under new ids, and the new head",
      frS2 !== null &&
        frS2.findings.length === 1 &&
        !frS2.findings.some((row) =>
          (frS1?.findings ?? []).some((old) => old.id === row.id),
        ) &&
        frS2.headSha === heads[S.freshTwo],
      frS2 ? `${frS2.findings.length} finding` : "nothing stored",
    ),
    check(
      "--fresh stores this run under new ids and the new head",
      frS2 !== null &&
        !frS2.findings.some((row) =>
          (frS1?.findings ?? []).some((old) => old.id === row.id),
        ) &&
        frS2.headSha === heads[S.freshTwo],
      frS2 ? `${frS2.findings.length} finding` : "nothing stored",
    ),
    check(
      "--fresh does not ask GitHub to compare the heads",
      !githubCalls(sim, S.freshTwo).some((call) => call.includes("/compare/")),
      "no compare call",
    ),
  );

  // A guide rebuilt between the runs.
  const g2 = firstRun(sim, S.guideTwo);
  const gp = promptOf(sim, S.guideTwo);
  const gs1 = stored[S.guideOne];
  const gs2 = stored[S.guideTwo];
  add(
    check(
      "a guide rebuilt since the last run sends no carry section and every changed file",
      !hasCarry(gp) &&
        unchangedListed(gp).length === 0 &&
        diffPaths(gp).sort().join() === [FORMAT_PATH, MATH_PATH].join(),
      `diff: ${diffPaths(gp).join()}`,
    ),
    scripted(
      sim,
      "a guide rebuilt since the last run judges the pull request as a first review",
      counts(g2) === "1 new · 0 open · 0 closed · 1 blocking" &&
        stateOf(g2, MATH_PATH) === "new" &&
        g2?.exitCode === 1,
      `${counts(g2)} · ${statesText(g2)}`,
    ),
    check(
      "a guide rebuilt since the last run stores the new guide time and new ids",
      gs1 !== null &&
        gs2 !== null &&
        typeof gs1.guideBuiltAt === "string" &&
        typeof gs2.guideBuiltAt === "string" &&
        Date.parse(gs2.guideBuiltAt) > Date.parse(gs1.guideBuiltAt) &&
        !gs2.findings.some((row) =>
          gs1.findings.some((old) => old.id === row.id),
        ),
      `${gs1?.guideBuiltAt} then ${gs2?.guideBuiltAt}`,
    ),
    check(
      "a guide rebuilt since the last run does not ask GitHub to compare the heads",
      !githubCalls(sim, S.guideTwo).some((call) => call.includes("/compare/")),
      "no compare call",
    ),
  );

  // A force-push, and an ordinary push for contrast.
  const x2 = firstRun(sim, S.forceTwo);
  const xp = promptOf(sim, S.forceTwo);
  const xs2 = stored[S.forceTwo];
  const pushedOnce = [S.humanTwo, S.jsonTwo, S.fourThree, S.fourFour].map(
    (step) => firstRun(sim, step),
  );
  add(
    check(
      "a force-push sends no carry section and says why the run started fresh",
      !hasCarry(xp) &&
        unchangedListed(xp).length === 0 &&
        log(x2).includes(
          "the head does not contain the last reviewed head (diverged), starting fresh",
        ),
      log(x2)
        .split("\n")
        .find((line) => line.includes("starting fresh")) ?? "no such log line",
    ),
    scripted(
      sim,
      "a force-push judges the rewritten branch as a first review",
      counts(x2) === "1 new · 0 open · 0 closed · 0 blocking" &&
        stateOf(x2, FORMAT_PATH) === "new" &&
        stateOf(x2, MATH_PATH) === undefined,
      `${counts(x2)} · ${statesText(x2)}`,
    ),
    check(
      "a force-push asks GitHub to compare the last reviewed head with the new one, once",
      githubCalls(sim, S.forceTwo).filter((call) => call.includes("/compare/"))
        .length === 1,
      "one compare call",
    ),
    check(
      "a force-push stores the rewritten head",
      xs2 !== null &&
        xs2.headSha === force.headSha &&
        xs2.headSha !== heads[S.forceOne],
      xs2 ? `head ${xs2.headSha?.slice(0, 7)}` : "nothing stored",
    ),
    check(
      "an ordinary push keeps the carry-over and does not say it started fresh",
      pushedOnce.every(
        (run) => run !== undefined && !log(run).includes("starting fresh"),
      ) &&
        githubCalls(sim, S.humanTwo).some((call) =>
          call.includes(`repos/${CLI_PR_REPO}/compare/`),
        ),
      `${pushedOnce.length} runs after a push, each asked GitHub to compare`,
    ),
    check(
      "a first run and a same-head run do not ask GitHub to compare the heads",
      [S.humanOne, S.jsonOne, S.fourOne, S.fourTwo].every(
        (step) =>
          !githubCalls(sim, step).some((call) => call.includes("/compare/")),
      ),
      "no compare call",
    ),
  );

  // ---- a local review of the same repository
  const local = sim.state.localRun as CliRun | undefined;
  const localPrompt =
    local?.completions().find((call) => call.job === "review_local")
      ?.firstUser ?? "";
  const localBefore = (sim.state.localBefore ?? {}) as Record<string, string>;
  const afterLocal = (sim.state.afterLocal ?? []) as {
    key: string;
    value: string;
  }[];
  const localRows = afterLocal.filter(
    (row) => !row.key.includes("\0pull-request\0"),
  );
  add(
    scripted(
      sim,
      "a local review of the same repository does not see the pull request runs",
      local?.exitCode === 1 &&
        !hasCarry(localPrompt) &&
        counts(local) === "2 new · 0 open · 0 closed · 1 blocking",
      `${counts(local)} · carry section ${hasCarry(localPrompt)}`,
    ),
    check(
      "a local review keeps its own row and leaves every pull request row as it was",
      localRows.length === 1 &&
        Object.entries(localBefore).length > 0 &&
        Object.entries(localBefore).every(([rowKey, value]) =>
          afterLocal.some((row) => row.key === rowKey && row.value === value),
        ),
      `${localRows.length} local row, ${Object.keys(localBefore).length} pull request rows unchanged`,
    ),
  );

  // ---- clear
  const cleared = runsOf(sim, S.clear)[0];
  add(
    check(
      "clear --include-cache removes the stored pull request runs and the local one",
      cleared?.exitCode === 0 &&
        Number(sim.state.rowsBeforeClear ?? 0) >= 8 &&
        cacheRows(sim).length === 0,
      `${sim.state.rowsBeforeClear} rows before, ${cacheRows(sim).length} after`,
    ),
  );

  // ---- no writes, one way in
  const cliCalls = sim.cliRuns.flatMap((run) => run.github());
  const prRuns = sim.cliRuns.filter((run) => run.args[0] === "review");
  add(
    check(
      "nothing is written to GitHub in any run",
      sim.github.writes.length === 0 &&
        sim.github.reviews.length === 0 &&
        cliCalls.every((call) => call.method === "GET"),
      `${prRuns.length} reviews, ${cliCalls.length} GitHub calls, ${cliCalls.filter((call) => call.method !== "GET").length} not reads, ${sim.github.writes.length} writes recorded`,
    ),
    check(
      "a pull request review reaches GitHub only through gh",
      sim.cliRuns
        .filter((run) => run.args.includes(String(human.number)))
        .flatMap((run) => run.github())
        .every((call) => call.via === "gh"),
      "every call of the first pull request's runs went through gh",
    ),
    scripted(
      sim,
      "the exit code is 1 exactly when a blocking finding is still standing",
      prRuns
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
    check(
      "every review ran to the end",
      prRuns.every((run) => run.exitCode === 0 || run.exitCode === 1),
      prRuns.map((run) => run.exitCode).join(" "),
    ),
  );
  return results;
}

// ------------------------------------------------------------------- scores

/** What would move with a real model. Not a measurement on the fake AI. */
function flowScores(sim: Sim): Score[] {
  const fakeAi = sim.mode === "fake";
  // Every review run after the first of its pull request that was handed
  // earlier findings.
  const carried = sim.cliRuns.filter((run) => {
    const prompt =
      run.completions().find((call) => call.job === "review_pull_request")
        ?.firstUser ?? "";
    return run.args[0] === "review" && hasCarry(prompt);
  });
  let asked = 0;
  let answered = 0;
  let restated = 0;
  for (const run of carried) {
    const prompt =
      run.completions().find((call) => call.job === "review_pull_request")
        ?.firstUser ?? "";
    const entries = carryEntries(prompt);
    asked += entries.length;
    const verdicts = (answerOf(run)?.previousFindings ?? []) as Json[];
    answered += entries.filter((entry) =>
      verdicts.some((item) => item.id === entry.label),
    ).length;
    // A finding reported as new on a path an earlier finding already covers
    // restates it.
    const covered = new Set(entries.map((entry) => entry.path));
    restated += rowsOf(run).filter(
      (row) => row.state === "new" && covered.has(String(row.path)),
    ).length;
  }
  const fullDiff = (promptOf(sim, S.humanOne) || " ").split("\nDIFF:\n")[1];
  const partDiff = (promptOf(sim, S.humanTwo) || " ").split("\nDIFF:\n")[1];
  const part = (partDiff ?? "").split("\nUNCHANGED SINCE")[0]!.length;
  return [
    {
      name: "earlier findings the model gave a verdict for",
      value: asked ? answered / asked : null,
      detail: `${answered} of ${asked} earlier findings sent in ${carried.length} runs got a line in the previous findings section`,
      fakeAi,
      ...(asked ? {} : { skipped: "no run was handed earlier findings" }),
    },
    {
      name: "findings the model reported again as new",
      value: restated,
      detail: `${restated} new findings on a path an earlier finding already covered`,
      fakeAi,
    },
    {
      name: "run 2 diff sent against run 1",
      value: fullDiff ? part / fullDiff.length : null,
      detail: `${part} chars against ${fullDiff?.length ?? 0}`,
      fakeAi,
    },
  ];
}

export default defineFlow({
  name: "cli-pr-carry",
  description:
    "co-maintainer review owner/repo N on the same pull request again and again: closed, open and new, --fresh, a rebuilt guide, a force-push and what is stored",
  ai: [...cliPrAi(), REVIEWER],
  skipInherited: {
    "cost recorded for every AI call":
      "the last step is clear --include-cache, which deletes the cost rows on purpose",
  },
  steps,
  checks: flowChecks,
  scores: flowScores,
});
