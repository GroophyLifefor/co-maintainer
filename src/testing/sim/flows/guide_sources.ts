/** Guide sources: every guide check line names the findings it merges, code
 * turns that into an `R` id, and `RULES.json` keeps the pull requests behind
 * each id with their merge dates.
 *
 * The base init-sync history is reused. The fake model writes the base flow's
 * guides and ends each check line with the numbers of the findings it came
 * from, read out of the prompt, as the guide prompt asks. A later run has the
 * model put a bracket mid-line, invent a number and write `items[3]` in a
 * check line, and the guide text must survive it. */
import { existsSync, readFileSync } from "node:fs";
import type { AiCall, AiReply, AiRule } from "../fake_ai.ts";
import {
  type CheckResult,
  type CliRun,
  check,
  defineFlow,
  type Score,
  type Sim,
} from "../flow.ts";
import type { SimPull } from "../github.ts";
import { touch } from "./github_people.ts";
import {
  buildHistory,
  type History,
  HISTORY_REPO,
  INIT_SYNC_AI,
  type Moved,
  moveWorld,
  RULES,
  runInit,
  runSync,
  type SetupRun,
} from "./init_sync.ts";

const FULL = "full review method";
const SHORT = "short review checklist";

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

function baseReply(name: string): (call: AiCall) => string {
  const rule = INIT_SYNC_AI.find((item) => item.name === name);
  const reply = rule?.reply as ((call: AiCall) => AiReply) | undefined;
  if (!reply) throw new Error(`the base flow has no "${name}" rule`);
  return (call) => String(reply(call));
}

/** The base flow's guide, with each check line ending in the numbers of the
 * findings whose rule it states. */
function withSources(name: string): (call: AiCall) => string {
  const base = baseReply(name);
  return (call) => {
    const findings = (jsonAfter(call.prompt, "FINDINGS:\n") ?? []) as {
      number?: number;
      rule: string;
    }[];
    return base(call)
      .split("\n")
      .map((line) => {
        const text = /^- (.+) · /.exec(line)?.[1];
        if (!text) return line;
        const numbers = findings
          .filter((finding) => finding.rule === text && finding.number)
          .map((finding) => finding.number);
        return numbers.length ? `${line} [${numbers.join(", ")}]` : line;
      })
      .join("\n");
  };
}

/** A check line that ends in a finding bracket. */
const SOURCED = /^- .+ · .+ \[\d+(?:, \d+)*\]$/;

/** The same guide, with three check lines the way a careless model writes
 * them: `items[3]` in the rule, the bracket in the middle of the line, and a
 * finding number that does not exist. */
function oddGuide(call: AiCall): string {
  let seen = 0;
  return withSources(FULL)(call)
    .split("\n")
    .map((line) => {
      if (!SOURCED.test(line)) return line;
      seen++;
      if (seen === 1) return line.replace(" · ", ", never through items[3] · ");
      if (seen === 2) {
        const match = /^(- .+?)( · .+) (\[[\d, ]+\])$/.exec(line)!;
        return `${match[1]} ${match[3]}${match[2]}`;
      }
      if (seen === 3) return line.replace(/\[[\d, ]+\]$/, "[999]");
      return line;
    })
    .join("\n");
}

export const GUIDE_SOURCES_AI: AiRule[] = [
  {
    name: "full method with sources",
    job: "synth_guide",
    reply: withSources(FULL),
  },
  {
    name: "short checklist with sources",
    job: "synth_guide_short",
    reply: withSources(SHORT),
  },
  ...INIT_SYNC_AI.filter((rule) => rule.name !== FULL && rule.name !== SHORT),
];

// Reading what was built.

type RuleEntry = {
  file: string;
  text: string;
  sources: { pr?: number; mergedAt?: string; path?: string; line?: number }[];
};

function read(sim: Sim, name: string): string {
  const path = `${sim.paths.reposDir}/${HISTORY_REPO}/${name}`;
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function guideRules(sim: Sim): Record<string, RuleEntry> {
  try {
    const all = (
      JSON.parse(read(sim, "RULES.json")) as {
        rules: Record<string, RuleEntry>;
      }
    ).rules;
    return Object.fromEntries(
      Object.entries(all).filter(([id]) => id.startsWith("R")),
    );
  } catch {
    return {};
  }
}

/** Top-level `rule · why` lines, the guide's checks. */
function checkLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^- .+ · /.test(line) && !line.includes("]("));
}

type Built = {
  run: SetupRun;
  guide: string;
  detailed: string;
  rules: Record<string, RuleEntry>;
};

function built(sim: Sim, run: SetupRun): Built {
  return {
    run,
    guide: read(sim, "PR_REVIEW_GUIDE.md"),
    detailed: read(sim, "PR_REVIEW_DETAILED_GUIDE.md"),
    rules: guideRules(sim),
  };
}

export const STEP = {
  history: "repository with history",
  init: "init with pull requests",
  view: "view --sources",
  move: "a new pull request is merged",
  sync: "sync after the new pull request",
  odd: "sync with a careless guide answer",
} as const;

export default defineFlow({
  name: "guide-sources",
  description:
    "guide check lines get R ids, RULES.json names the pull requests behind them, sync reports which lines changed and why",
  ai: GUIDE_SOURCES_AI,
  steps: [
    {
      name: STEP.history,
      run(sim) {
        sim.state.history = buildHistory(sim);
        return `${sim.github.pulls.length} pull requests`;
      },
    },
    {
      name: STEP.init,
      async run(sim) {
        sim.state.init = built(sim, await runInit(sim));
        return `${Object.keys(guideRules(sim)).length} guide rules`;
      },
    },
    {
      name: STEP.view,
      async run(sim) {
        const human = await sim.cli(["view", HISTORY_REPO, "--sources"]);
        const json = await sim.cli([
          "view",
          HISTORY_REPO,
          "--sources",
          "--json",
        ]);
        sim.state.view = { human, json };
        return `exit ${human.exitCode}, --json exit ${json.exitCode}`;
      },
    },
    {
      name: STEP.move,
      run(sim) {
        const moved = moveWorld(sim, sim.state.history as History);
        sim.state.moved = moved;
        return `#${moved.negative.number} merged with a new rule`;
      },
    },
    {
      name: STEP.sync,
      async run(sim) {
        sim.state.sync = built(sim, await runSync(sim));
        return `${Object.keys(guideRules(sim)).length} guide rules`;
      },
    },
    {
      name: STEP.odd,
      async run(sim) {
        // One more rule, so the guide is written again.
        const { negative, negateLine } = sim.state.moved as Moved;
        sim.github.reviewComment(negative, {
          path: "src/math.ts",
          line: negateLine,
          body: `Rule: ${RULES.formatTest}`,
        });
        touch(negative);
        sim.ai.use({
          name: "careless full method",
          job: "synth_guide",
          times: 1,
          reply: oddGuide,
        });
        sim.state.odd = built(sim, await runSync(sim));
        return "guide written again";
      },
    },
  ],
  checks: guideSourceChecks,
  scores: guideSourceScores,
});

// Checks.

const listOf = (items: unknown[]) => items.join(", ") || "none";

function fakeOnly(sim: Sim, result: CheckResult): CheckResult {
  return sim.mode === "fake"
    ? result
    : { ...result, ok: true, skipped: "reads the fake AI's answers" };
}

/** The pull request each rule a maintainer wrote came from. */
function rulePulls(history: History): Map<string, SimPull> {
  const { clamp, percent, exports, table } = history.pulls;
  return new Map<string, SimPull>([
    [RULES.clampTest, clamp],
    [RULES.testNames, clamp],
    [RULES.percentRange, percent],
    [RULES.namedExports, exports],
    [RULES.generated, table],
  ]);
}

const plain = (text: string) => text.replaceAll("`", "");

function initChecks(sim: Sim): CheckResult[] {
  const init = sim.state.init as Built | undefined;
  const history = sim.state.history as History | undefined;
  if (!init || !history) return [check("init ran", false, "no init")];
  const lines = [...checkLines(init.guide), ...checkLines(init.detailed)];
  const unsourced = lines.filter((line) => !/ \[R[1-9]\d*\]$/.test(line));
  const pulls = rulePulls(history);
  const wrong = Object.entries(init.rules).flatMap(([id, entry]) => {
    const rule = [...pulls.keys()].find((text) =>
      entry.text.startsWith(`${plain(text)} · `),
    );
    const pull = rule ? pulls.get(rule) : undefined;
    const want = pull
      ? [
          pull.mergedAt
            ? { pr: pull.number, mergedAt: pull.mergedAt.slice(0, 10) }
            : { pr: pull.number },
        ]
      : [];
    return JSON.stringify(entry.sources) === JSON.stringify(want)
      ? []
      : [`${id} ${JSON.stringify(entry.sources)} want ${JSON.stringify(want)}`];
  });
  return [
    fakeOnly(
      sim,
      check(
        "every guide check line ends with a rule id",
        lines.length > 0 && unsourced.length === 0,
        `${lines.length - unsourced.length} of ${lines.length} check lines · without: ${listOf(unsourced.slice(0, 3))}`,
      ),
    ),
    fakeOnly(
      sim,
      check(
        "RULES.json maps each R id to the pull request its comment came from",
        Object.keys(init.rules).length === pulls.size && wrong.length === 0,
        wrong.length
          ? wrong.slice(0, 3).join(" · ")
          : `${Object.keys(init.rules).length} ids, each with its pull request and merge date`,
      ),
    ),
    check(
      "no pull request number reaches the guide prompt",
      sim.trace.completions
        .filter((call) => call.job.startsWith("synth_guide"))
        .every((call) => !/#\d+\b|PR #\d/.test(call.firstUser)),
      "checked every guide call",
    ),
  ];
}

function viewChecks(sim: Sim): CheckResult[] {
  const view = sim.state.view as { human: CliRun; json: CliRun } | undefined;
  const init = sim.state.init as Built | undefined;
  const rules = init?.rules ?? {};
  const missing = Object.entries(rules).filter(([id, entry]) => {
    const pull = entry.sources[0];
    const month = pull?.mergedAt?.slice(0, 7);
    const sources = month
      ? `#${pull?.pr} · ${month} · 1 PR`
      : `#${pull?.pr} · 1 PR`;
    return (
      !view?.human.stdout.includes(`${id}  ${entry.text}`) ||
      !view.human.stdout.includes(sources)
    );
  });
  let printed: Record<string, unknown> = {};
  try {
    printed =
      (
        JSON.parse(view?.json.stdout ?? "{}") as {
          rules?: Record<string, unknown>;
        }
      ).rules ?? {};
  } catch {
    // Checked below.
  }
  const jsonMatches = Object.entries(rules).every(
    ([id, entry]) => JSON.stringify(printed[id]) === JSON.stringify(entry),
  );
  return [
    check(
      "view --sources names each guide rule's pull request and merge month",
      view?.human.exitCode === 0 &&
        Object.keys(rules).length > 0 &&
        missing.length === 0 &&
        jsonMatches,
      missing.length
        ? `missing or wrong: ${listOf(missing.map(([id]) => id))}`
        : `${Object.keys(rules).length} rules · --json ${jsonMatches ? "matches RULES.json" : "differs"}`,
    ),
  ];
}

function syncChecks(sim: Sim): CheckResult[] {
  const sync = sim.state.sync as Built | undefined;
  const moved = sim.state.moved as Moved | undefined;
  const history = sim.state.history as History | undefined;
  if (!sync || !moved || !history) return [check("sync ran", false, "no sync")];
  const negative = `#${moved.negative.number}`;
  const percent = `#${history.pulls.percent.number}`;
  const line = sync.run.stderr
    .split("\n")
    .find((text) => text.startsWith("[guide] "));
  const changes = (
    sync.run.json.ruleChanges as
      | {
          guide?: {
            added: { id: string; sources: string[] }[];
            rewritten: { id: string; joined: string[] }[];
            dropped: unknown[];
          };
        }
      | undefined
  )?.guide;
  const rewritten = changes?.rewritten.map((rule) => rule.id) ?? [];
  const rewrittenToPercent = rewritten.filter((id) =>
    sync.rules[id]?.sources.some((source) => `#${source.pr}` === percent),
  );
  return [
    fakeOnly(
      sim,
      check(
        "sync reports the line the new pull request added and the one an edit rewrote",
        changes?.added.length === 1 &&
          JSON.stringify(changes.added[0]!.sources) ===
            JSON.stringify([negative]) &&
          rewrittenToPercent.length === 1 &&
          rewritten.length === 1 &&
          changes.dropped.length === 0 &&
          line ===
            `[guide] 1 rule added (${negative}) · 1 rewritten (${rewritten[0]})`,
        `${line ?? "no [guide] line"} · rewritten ids resting on ${percent}: ${listOf(rewrittenToPercent)}`,
      ),
    ),
  ];
}

function oddChecks(sim: Sim): CheckResult[] {
  const odd = sim.state.odd as Built | undefined;
  const detailed = checkLines(odd?.detailed ?? "");
  const items = detailed.filter((line) =>
    line.includes(", never through items[3] · "),
  );
  const midLine = detailed.filter((line) =>
    /^- .+ \[\d+(, \d+)*\] · /.test(line),
  );
  const leftover = detailed.filter((line) => /\[\d+(, \d+)*\]$/.test(line));
  return [
    fakeOnly(
      sim,
      check(
        "a careless guide answer leaves the guide text intact",
        odd?.run.exitCode === 0 &&
          items.length === 1 &&
          / \[R[1-9]\d*\]$/.test(items[0]!) &&
          midLine.length === 1 &&
          !/ \[R[1-9]\d*\]$/.test(midLine[0]!) &&
          leftover.length === 0 &&
          !odd.detailed.includes("[999]"),
        `items[3] line ${items.length ? (/ \[R\d+\]$/.test(items[0]!) ? "kept with an id" : "kept, no id") : "lost"} · mid-line bracket ${midLine.length ? "kept" : "lost"} · invented number ${odd?.detailed.includes("[999]") ? "kept" : "dropped"} · raw end brackets ${leftover.length}`,
      ),
    ),
  ];
}

export async function guideSourceChecks(sim: Sim): Promise<CheckResult[]> {
  return [
    ...initChecks(sim),
    ...viewChecks(sim),
    ...syncChecks(sim),
    ...oddChecks(sim),
  ];
}

// Scores.

/** `[write] PR_REVIEW_GUIDE.md · 34 rules · 31 with sources`, per file. */
function writeCounts(run: SetupRun | undefined) {
  return [
    ...(run?.stderr ?? "").matchAll(
      /^\[write\] (PR_REVIEW_\w+\.md) · (\d+) rules? · (\d+) with sources$/gm,
    ),
  ].map((match) => ({
    file: match[1]!,
    rules: Number(match[2]),
    withIds: Number(match[3]),
  }));
}

export function guideSourceScores(sim: Sim): Score[] {
  const fakeAi = sim.mode === "fake";
  const counts = writeCounts((sim.state.init as Built | undefined)?.run);
  const rules = counts.reduce((sum, item) => sum + item.rules, 0);
  const withIds = counts.reduce((sum, item) => sum + item.withIds, 0);
  return [
    {
      // The first number issue 78 asks for: does the model keep the finding
      // numbers on its guide lines.
      name: "guide check lines with a valid source list",
      value: rules ? withIds / rules : null,
      detail: `${withIds} of ${rules} check lines · ${counts.map((item) => `${item.file} ${item.withIds}/${item.rules}`).join(" · ") || "no guide written"}`,
      fakeAi,
      data: Object.fromEntries(
        counts.map((item) => [
          item.file,
          { rules: item.rules, withIds: item.withIds },
        ]),
      ),
    },
  ];
}
