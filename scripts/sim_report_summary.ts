/** Summarizes e2e:simulate reports over several runs.
 *
 *   node scripts/sim_report_summary.ts <dir>
 *
 * Reads every JSON report that `npm run e2e:simulate -- --output=<dir>` wrote
 * into the directory, groups the scores by flow, and prints for each score the
 * mean, the sample standard deviation, the min and the max over the runs, and
 * how many runs had a value. A score computed on the fake AI's answers is
 * marked, because it measures nothing about a model. It works for any flow.
 *
 * For the `review-checks` flow it also prints the pass rule of issue 80 for
 * each check, computed from the runs it was given. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkRunsOf,
  SCORE,
  verdictLines,
  verdicts,
} from "../src/testing/sim/flows/review_checks_score.ts";

export type ReportScore = {
  name: string;
  value: number | null;
  detail?: string;
  fakeAi?: boolean;
  skipped?: string;
  data?: Record<string, unknown>;
};

export type Report = {
  file: string;
  mode: "fake" | "live" | "unknown";
  model: string;
  passed: boolean;
  flows: { name: string; passed: boolean; scores: ReportScore[] }[];
};

/** Every report in `dir`, oldest first by file name, which starts with the
 * time the run started. A file that is not a report is named and skipped. */
export function loadReports(dir: string): {
  reports: Report[];
  skipped: string[];
} {
  const reports: Report[] = [];
  const skipped: string[] = [];
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        tool?: string;
        passed?: boolean;
        ai?: { mode?: string; highModel?: string };
        flows?: {
          name?: string;
          passed?: boolean;
          scores?: ReportScore[];
        }[];
      };
      if (raw.tool !== "e2e:simulate" || !Array.isArray(raw.flows)) {
        skipped.push(`${name}: not an e2e:simulate report`);
        continue;
      }
      const mode = raw.ai?.mode;
      reports.push({
        file: name,
        mode: mode === "fake" || mode === "live" ? mode : "unknown",
        model: String(raw.ai?.highModel ?? ""),
        passed: raw.passed === true,
        flows: raw.flows.map((flow) => ({
          name: String(flow.name ?? ""),
          passed: flow.passed === true,
          scores: Array.isArray(flow.scores) ? flow.scores : [],
        })),
      });
    } catch (error) {
      skipped.push(`${name}: ${(error as Error).message}`);
    }
  }
  return { reports, skipped };
}

export type Stat = {
  score: string;
  /** Runs that had a value for this score. */
  runs: number;
  /** Runs where the score was skipped, failed or unknown. */
  missing: number;
  mean: number;
  /** The sample standard deviation, n - 1 in the divisor. Zero for one run. */
  sd: number;
  min: number;
  max: number;
  fakeAi: boolean;
};

export function stats(
  values: number[],
): Pick<Stat, "mean" | "sd" | "min" | "max"> {
  const n = values.length;
  if (n === 0) return { mean: 0, sd: 0, min: 0, max: 0 };
  const mean = values.reduce((total, value) => total + value, 0) / n;
  const variance =
    n > 1
      ? values.reduce((total, value) => total + (value - mean) ** 2, 0) /
        (n - 1)
      : 0;
  return {
    mean,
    sd: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** Each flow's scores over the reports, in the order the first run listed
 * them. */
export function summarize(reports: Report[]): Map<string, Stat[]> {
  const byFlow = new Map<
    string,
    Map<string, { values: number[]; missing: number; fakeAi: boolean }>
  >();
  for (const report of reports) {
    for (const flow of report.flows) {
      let scores = byFlow.get(flow.name);
      if (!scores) byFlow.set(flow.name, (scores = new Map()));
      for (const score of flow.scores) {
        const entry = scores.get(score.name) ?? {
          values: [],
          missing: 0,
          fakeAi: false,
        };
        if (
          score.skipped ||
          typeof score.value !== "number" ||
          !Number.isFinite(score.value)
        ) {
          entry.missing++;
        } else {
          entry.values.push(score.value);
        }
        entry.fakeAi ||= score.fakeAi === true;
        scores.set(score.name, entry);
      }
    }
  }
  const out = new Map<string, Stat[]>();
  for (const [flow, scores] of byFlow) {
    out.set(
      flow,
      [...scores].map(([score, entry]) => ({
        score,
        runs: entry.values.length,
        missing: entry.missing,
        fakeAi: entry.fakeAi,
        ...stats(entry.values),
      })),
    );
  }
  return out;
}

const number = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(value >= 100 ? 1 : 4);

/** The pass rule of issue 80 over the review-checks runs, with the numbers
 * the rule rests on. */
export function checksVerdict(reports: Report[]): string[] {
  const runs = reports.flatMap((report) =>
    report.flows
      .filter((flow) => flow.name === "review-checks")
      .map((flow) => ({ report, flow })),
  );
  if (!runs.length) return [];
  const fake = runs.filter(({ report }) => report.mode !== "live").length;
  const value = (scores: ReportScore[], name: string) =>
    scores.find((score) => score.name === name)?.value ?? null;
  const mean = (name: string) => {
    const values = runs
      .map(({ flow }) => value(flow.scores, name))
      .filter((item): item is number => typeof item === "number");
    return values.length ? number(stats(values).mean) : "unknown";
  };
  const lines = [
    "",
    `review-checks: the pass rule of issue 80 over ${runs.length} run${runs.length === 1 ? "" : "s"}`,
    ...(fake
      ? [
          `  ${fake} of them on the fake AI: these verdicts measure nothing about a model`,
        ]
      : []),
    ...(runs.length < 3
      ? ["  The issue asks for three runs. This verdict is provisional."]
      : []),
    ...verdictLines(
      verdicts(runs.map(({ flow }) => checkRunsOf(flow.scores))),
    ).map((line) => `  ${line}`),
    `  False findings without a tag, checks arm: ${mean(SCORE.falseUntagged)} per run. They cannot be pinned on one check.`,
    `  False findings, baseline: ${mean(SCORE.falseBaseline)} per run · checks arm: ${mean(SCORE.falseChecks)} per run`,
    "  Rule: a check passes when the checks arm catches its seeded defect in at least one run where the baseline missed it, and it adds at most one false finding with its id per run, averaged over the runs.",
  ];
  return lines;
}

export function render(reports: Report[], skipped: string[] = []): string {
  const lines: string[] = [];
  const modes = [...new Set(reports.map((report) => report.mode))].join(", ");
  lines.push(
    `${reports.length} report${reports.length === 1 ? "" : "s"} · ${modes || "none"}`,
  );
  for (const line of skipped) lines.push(`skipped ${line}`);
  for (const [flow, scores] of summarize(reports)) {
    const passed = reports.flatMap((report) =>
      report.flows.filter((item) => item.name === flow),
    );
    lines.push(
      "",
      `${flow} · ${passed.length} runs · ${passed.filter((item) => item.passed).length} passed`,
    );
    for (const stat of scores) {
      const values = stat.runs
        ? `mean ${number(stat.mean)} · sd ${number(stat.sd)} · min ${number(stat.min)} · max ${number(stat.max)}`
        : "no value";
      const missing = stat.missing ? ` · ${stat.missing} without a value` : "";
      const fake = stat.fakeAi ? " · fake AI, not a measurement" : "";
      lines.push(
        `  ${stat.score} · ${values} · ${stat.runs} runs${missing}${fake}`,
      );
    }
  }
  lines.push(...checksVerdict(reports));
  return lines.join("\n");
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error(
      "Usage: node scripts/sim_report_summary.ts <dir with e2e:simulate reports>",
    );
    process.exit(2);
  }
  const { reports, skipped } = loadReports(dir);
  if (!reports.length) {
    console.error(`No e2e:simulate report in ${dir}.`);
    process.exit(1);
  }
  console.log(render(reports, skipped));
}
