/** How a simulated run is shown: one terminal line per step, check and score,
 * and with `--output=<dir>` one JSON file per run holding the summary and,
 * per flow, the full trace. AI keys never reach either. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, Score } from "./checks/common.ts";

export type StepResult = {
  name: string;
  ok: boolean;
  /** When the step started, in ms since the run started. */
  startMs: number;
  ms: number;
  detail: string;
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

export function printStep(step: StepResult): void {
  const status = step.ok ? "ok  " : "FAIL";
  const detail = step.detail ? ` · ${step.detail}` : "";
  console.log(`${status}  ${step.name}${detail} · ${seconds(step.ms)}`);
}

export function printCheck(check: CheckResult): void {
  if (check.skipped !== undefined) {
    console.log(`skip  check ${check.name} · ${check.skipped}`);
    return;
  }
  console.log(
    `${check.ok ? "ok  " : "FAIL"}  check ${check.name} · ${check.detail}`,
  );
}

export function printScore(score: Score): void {
  if (score.skipped) {
    console.log(`skip  score ${score.name} · ${score.skipped}`);
    return;
  }
  const value = score.value === null ? "unknown" : score.value.toFixed(4);
  const fake = score.fakeAi ? " · fake AI, not a measurement" : "";
  console.log(`      score ${score.name} · ${value} · ${score.detail}${fake}`);
}

/** The shape of the JSON report. Raise it whenever a field is added, removed
 * or changes meaning, so reports kept over time can be told apart, and add a
 * renderer for the new version in `dev-work/e2e-simulate/visualizer/app.js`.
 *
 * 1: the first report. 2: `startMs` on steps, calls, leaks, logs and git
 * commands, and the judge as its own step. 3: one entry per flow in `flows`,
 * each with its own steps, checks, scores and trace. The trace adds remote
 * calls, webhook deliveries, GitHub writes, completions, server jobs and
 * faults. A check can be skipped with a reason. */
export const REPORT_SCHEMA_VERSION = 3;

/** Writes `<dir>/<time>_<sha>.json` and returns its path. A new file per run,
 * so the history builds up in the directory. */
export function writeReport(
  dir: string,
  sha: string,
  report: Record<string, unknown>,
): string {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const path = join(dir, `${stamp}_${sha.slice(0, 7)}.json`);
  const versioned = { schemaVersion: REPORT_SCHEMA_VERSION, ...report };
  writeFileSync(path, `${JSON.stringify(versioned, null, 2)}\n`);
  return path;
}
