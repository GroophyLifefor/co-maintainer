/** Scoring of the `review-checks` flow, and the pass rule of issue 80.
 *
 * Everything here is deterministic: a finding is placed by its path, its
 * lines and its severity, never judged by a model.
 *
 * - A catch is a finding on a seeded change that touches the seeded lines
 *   (with `SLACK` lines either side) at P0 to P2. For C7 a P3 counts too: that
 *   check asks for one.
 * - A false finding is a P0 to P2 finding on a fixed twin or a clean change.
 *   A P3 there is counted apart.
 * - Any other finding on a seeded change is "other", not false.
 * - A finding is tagged when its body, or failing that its title, starts with
 *   a check id in brackets, such as `[C3]`.
 *
 * The pure functions are shared by the flow and by
 * `scripts/sim_report_summary.ts`, which applies the pass rule over runs. */
import type { Score } from "../checks/common.ts";
import { CHECK_IDS, type CheckId } from "./review_checks_repo.ts";

export type Arm = "baseline" | "checks";
export type Kind = "seeded" | "fixed" | "clean";

/** Lines a finding may sit beside the seeded lines and still count. */
export const SLACK = 3;

export type FindingInput = {
  path: string;
  lineFrom: number;
  lineTo: number;
  severity: string;
  title: string;
  body: string;
};

export type ResolvedSpan = { path: string; from: number; to: number };

/** One review, as the scoring sees it. */
export type ReviewInput = {
  change: string;
  kind: Kind;
  /** The check of the pair, for a seeded change or a twin. */
  check?: CheckId;
  arm: Arm;
  /** False when the review did not run to its end (exit 2 or 3). */
  finished: boolean;
  findings: FindingInput[];
  /** Where the seeded defect is, for a seeded change. */
  spans: ResolvedSpan[];
  usage: {
    tokensIn: number;
    tokensOut: number;
    usd: number | null;
    calls: number;
  };
};

export type FindingClass = "catch" | "false" | "p3" | "other";

export type ClassifiedFinding = {
  path: string;
  lines: string;
  severity: string;
  tag: CheckId | null;
  class: FindingClass;
  /** True for a finding on the seeded lines whose severity was too low to
   * count, so a check that finds the defect but calls it P3 still shows. */
  lowAtSeed?: boolean;
  title: string;
};

const SERIOUS = new Set(["P0", "P1", "P2"]);

/** The check id a finding names, from its body or else its title. */
export function tagOf(
  finding: Pick<FindingInput, "body" | "title">,
): CheckId | null {
  for (const text of [finding.body, finding.title]) {
    const match = /^\s*\[(C[1-7])\]/.exec(String(text ?? ""));
    if (match) return match[1] as CheckId;
  }
  return null;
}

export function touches(
  finding: Pick<FindingInput, "path" | "lineFrom" | "lineTo">,
  span: ResolvedSpan,
  slack = SLACK,
): boolean {
  const from = Number(finding.lineFrom);
  const to = Number.isFinite(Number(finding.lineTo))
    ? Number(finding.lineTo)
    : from;
  return (
    finding.path === span.path &&
    Math.min(from, to) <= span.to + slack &&
    Math.max(from, to) >= span.from - slack
  );
}

export function classify(review: ReviewInput): ClassifiedFinding[] {
  return review.findings.map((finding) => {
    const severity = String(finding.severity);
    const base = {
      path: finding.path,
      lines:
        finding.lineTo && finding.lineTo !== finding.lineFrom
          ? `${finding.lineFrom}-${finding.lineTo}`
          : String(finding.lineFrom),
      severity,
      tag: tagOf(finding),
      title: finding.title,
    };
    if (review.kind !== "seeded") {
      return { ...base, class: SERIOUS.has(severity) ? "false" : "p3" };
    }
    const atSeed = review.spans.some((span) => touches(finding, span));
    const counts =
      SERIOUS.has(severity) || (review.check === "C7" && severity === "P3");
    if (atSeed && counts) return { ...base, class: "catch" };
    return { ...base, class: "other", ...(atSeed ? { lowAtSeed: true } : {}) };
  });
}

/** The numbers of one arm. */
export type ArmTally = {
  reviews: number;
  unfinished: string[];
  catches: Record<CheckId, number>;
  /** P0 to P2 findings on twins and clean changes, by change. */
  falseByChange: Record<string, number>;
  p3ByChange: Record<string, number>;
  falseTagged: Record<CheckId, number>;
  falseUntagged: number;
  /** Catches whose finding names a check, by the id it names. */
  taggedCatches: Record<CheckId, number>;
  other: number;
  lowAtSeed: Record<CheckId, number>;
  tokensIn: number;
  tokensOut: number;
  usd: number | null;
  calls: number;
};

const zeroes = (): Record<CheckId, number> =>
  Object.fromEntries(CHECK_IDS.map((id) => [id, 0])) as Record<CheckId, number>;

const sum = (values: Record<string, number>) =>
  Object.values(values).reduce((total, value) => total + value, 0);

export function tallyArm(reviews: ReviewInput[], arm: Arm): ArmTally {
  const tally: ArmTally = {
    reviews: 0,
    unfinished: [],
    catches: zeroes(),
    falseByChange: {},
    p3ByChange: {},
    falseTagged: zeroes(),
    falseUntagged: 0,
    taggedCatches: zeroes(),
    other: 0,
    lowAtSeed: zeroes(),
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    calls: 0,
  };
  for (const review of reviews.filter((item) => item.arm === arm)) {
    tally.reviews++;
    tally.tokensIn += review.usage.tokensIn;
    tally.tokensOut += review.usage.tokensOut;
    tally.calls += review.usage.calls;
    tally.usd =
      tally.usd === null || review.usage.usd === null
        ? null
        : tally.usd + review.usage.usd;
    if (!review.finished) {
      tally.unfinished.push(review.change);
      continue;
    }
    const found = classify(review);
    if (review.kind !== "seeded") {
      tally.falseByChange[review.change] = found.filter(
        (item) => item.class === "false",
      ).length;
      tally.p3ByChange[review.change] = found.filter(
        (item) => item.class === "p3",
      ).length;
    }
    let caught = false;
    for (const item of found) {
      if (item.class === "catch") {
        caught = true;
        if (item.tag) tally.taggedCatches[item.tag]++;
      } else if (item.class === "false") {
        if (item.tag) tally.falseTagged[item.tag]++;
        else tally.falseUntagged++;
      } else if (item.class === "other") {
        tally.other++;
        if (item.lowAtSeed && review.check) tally.lowAtSeed[review.check]++;
      }
    }
    if (caught && review.check) tally.catches[review.check] = 1;
  }
  return tally;
}

/** What one run says about one check, kept in that check's score. */
export type CheckRun = {
  check: CheckId;
  baselineCatches: number;
  checksCatches: number;
  falseWithTag: number;
  taggedCatches: number;
};

export function checkRuns(baseline: ArmTally, checks: ArmTally): CheckRun[] {
  return CHECK_IDS.map((check) => ({
    check,
    baselineCatches: baseline.catches[check],
    checksCatches: checks.catches[check],
    falseWithTag: checks.falseTagged[check],
    taggedCatches: checks.taggedCatches[check],
  }));
}

export const SCORE = {
  catchesBaseline: "catches, baseline",
  catchesChecks: "catches, checks arm",
  falseBaseline: "false findings, baseline",
  falseChecks: "false findings, checks arm",
  falseTagged: "false findings with a check tag, checks arm",
  falseUntagged: "false findings without a tag, checks arm",
  taggedCatches: "catches that name a check, checks arm",
  otherBaseline: "other findings on seeded changes, baseline",
  otherChecks: "other findings on seeded changes, checks arm",
  usageBaseline: "input tokens, baseline",
  usageChecks: "input tokens, checks arm",
  systemPrompt: "system prompt growth from the checks",
  unfinished: "reviews that did not finish",
  codegraph: "reviews with codegraph tools",
} as const;

export type ScoreInput = {
  reviews: ReviewInput[];
  fakeAi: boolean;
  /** Characters of the review system prompt without and with the checks. */
  system: { baseline: number; checks: number };
  codegraph: { used: number; reason: string };
};

const list = (values: Record<string, number>) =>
  Object.entries(values)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ") || "none";

/** Every score the flow reports, from the reviews of one run. */
export function reviewScores(input: ScoreInput): Score[] {
  const { reviews, fakeAi } = input;
  const baseline = tallyArm(reviews, "baseline");
  const checks = tallyArm(reviews, "checks");
  const perReview = reviews.map((review) => ({
    change: review.change,
    kind: review.kind,
    check: review.check ?? null,
    arm: review.arm,
    finished: review.finished,
    findings: classify(review),
    usage: review.usage,
  }));
  const possible = CHECK_IDS.length;
  const usage = (tally: ArmTally) => ({
    tokensIn: tally.tokensIn,
    tokensOut: tally.tokensOut,
    usd: tally.usd,
    calls: tally.calls,
  });
  const scores: Score[] = [
    {
      name: SCORE.catchesBaseline,
      value: sum(baseline.catches),
      detail: `${sum(baseline.catches)} of ${possible} · ${list(baseline.catches)}`,
      fakeAi,
      data: { byCheck: baseline.catches, possible, reviews: perReview },
    },
    {
      name: SCORE.catchesChecks,
      value: sum(checks.catches),
      detail: `${sum(checks.catches)} of ${possible} · ${list(checks.catches)}`,
      fakeAi,
      data: { byCheck: checks.catches, possible },
    },
    {
      name: SCORE.falseBaseline,
      value: sum(baseline.falseByChange),
      detail: `${list(baseline.falseByChange)} · P3 apart: ${sum(baseline.p3ByChange)}`,
      fakeAi,
      data: {
        byChange: baseline.falseByChange,
        p3: sum(baseline.p3ByChange),
        p3ByChange: baseline.p3ByChange,
      },
    },
    {
      name: SCORE.falseChecks,
      value: sum(checks.falseByChange),
      detail: `${list(checks.falseByChange)} · P3 apart: ${sum(checks.p3ByChange)}`,
      fakeAi,
      data: {
        byChange: checks.falseByChange,
        p3: sum(checks.p3ByChange),
        p3ByChange: checks.p3ByChange,
      },
    },
    {
      name: SCORE.falseTagged,
      value: sum(checks.falseTagged),
      detail: list(checks.falseTagged),
      fakeAi,
      data: { byCheck: checks.falseTagged },
    },
    {
      name: SCORE.falseUntagged,
      value: checks.falseUntagged,
      detail: "a false finding without an id cannot be pinned on one check",
      fakeAi,
    },
    {
      name: SCORE.taggedCatches,
      value: sum(checks.taggedCatches),
      detail: list(checks.taggedCatches),
      fakeAi,
      data: { byCheck: checks.taggedCatches },
    },
    {
      name: SCORE.otherBaseline,
      value: baseline.other,
      detail: `on the seeded lines but below P2: ${list(baseline.lowAtSeed)}`,
      fakeAi,
      data: { lowAtSeed: baseline.lowAtSeed },
    },
    {
      name: SCORE.otherChecks,
      value: checks.other,
      detail: `on the seeded lines but below P2: ${list(checks.lowAtSeed)}`,
      fakeAi,
      data: { lowAtSeed: checks.lowAtSeed },
    },
    {
      name: SCORE.usageBaseline,
      value: baseline.tokensIn,
      detail: `${baseline.tokensIn} in, ${baseline.tokensOut} out, ${baseline.calls} calls, ${baseline.usd === null ? "cost unknown" : `$${baseline.usd.toFixed(4)}`}`,
      fakeAi,
      data: usage(baseline),
    },
    {
      name: SCORE.usageChecks,
      value: checks.tokensIn,
      detail: `${checks.tokensIn} in, ${checks.tokensOut} out, ${checks.calls} calls, ${checks.usd === null ? "cost unknown" : `$${checks.usd.toFixed(4)}`}`,
      fakeAi,
      data: usage(checks),
    },
    {
      name: SCORE.systemPrompt,
      value: input.system.checks - input.system.baseline,
      detail: `${input.system.baseline} characters without the checks, ${input.system.checks} with them`,
      fakeAi: false,
      data: input.system,
    },
    {
      name: SCORE.unfinished,
      value: baseline.unfinished.length + checks.unfinished.length,
      detail:
        [
          ...baseline.unfinished.map((name) => `${name} baseline`),
          ...checks.unfinished.map((name) => `${name} checks`),
        ].join(", ") || "none",
      fakeAi,
    },
    {
      name: SCORE.codegraph,
      value: input.codegraph.used,
      detail: input.codegraph.reason,
      fakeAi,
    },
  ];
  for (const run of checkRuns(baseline, checks)) {
    scores.push({
      name: run.check,
      value: run.checksCatches,
      detail: `${run.check}: baseline ${run.baselineCatches} of 1, checks ${run.checksCatches} of 1, false with tag ${run.falseWithTag}`,
      fakeAi,
      data: run,
    });
  }
  return scores;
}

// ------------------------------------------------------------- the pass rule

/** The issue's pass rule for one check, over the runs given. */
export type Verdict = {
  check: CheckId;
  pass: boolean;
  runs: number;
  /** Runs where the checks arm caught the defect and the baseline did not:
   * the closest thing here to the issue's "recorded miss" now reported. */
  gains: number;
  checksCaught: number;
  baselineCaught: number;
  falseWithTagMean: number;
};

/** The rule: a check catches at least one miss (a run where the checks arm
 * caught the defect and the baseline did not), and adds at most one false
 * finding with its id per run, averaged over the runs. */
export function verdicts(runs: CheckRun[][]): Verdict[] {
  return CHECK_IDS.map((check) => {
    const rows = runs
      .map((run) => run.find((row) => row.check === check))
      .filter((row): row is CheckRun => row !== undefined);
    const count = (pick: (row: CheckRun) => boolean) =>
      rows.filter(pick).length;
    const gains = count(
      (row) => row.checksCatches > 0 && row.baselineCatches === 0,
    );
    const falseWithTagMean = rows.length
      ? rows.reduce((total, row) => total + row.falseWithTag, 0) / rows.length
      : 0;
    return {
      check,
      pass: rows.length > 0 && gains >= 1 && falseWithTagMean <= 1,
      runs: rows.length,
      gains,
      checksCaught: count((row) => row.checksCatches > 0),
      baselineCaught: count((row) => row.baselineCatches > 0),
      falseWithTagMean,
    };
  });
}

/** The per-check rows of one run's scores, read back from a report. */
export function checkRunsOf(
  scores: Pick<Score, "name" | "data">[],
): CheckRun[] {
  return scores
    .filter((score) => (CHECK_IDS as string[]).includes(score.name))
    .map((score) => score.data as unknown as CheckRun)
    .filter((row) => row && typeof row.checksCatches === "number");
}

export function verdictLines(verdicts: Verdict[]): string[] {
  return verdicts.map((verdict) => {
    const why = verdict.pass
      ? "pass"
      : verdict.runs === 0
        ? "fail: no runs"
        : verdict.gains === 0
          ? "fail: no catch the baseline missed"
          : "fail: more than one false finding with its id per run";
    return `${verdict.check}  ${why} · checks caught it in ${verdict.checksCaught} of ${verdict.runs} runs, baseline in ${verdict.baselineCaught} · caught only with the checks in ${verdict.gains} · false findings with [${verdict.check}]: ${verdict.falseWithTagMean.toFixed(2)} per run`;
  });
}
