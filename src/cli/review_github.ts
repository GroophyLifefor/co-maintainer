/** `review --output=github`.
 *
 * Findings become GitHub workflow commands (`::error` and `::warning`) so a
 * pull request shows them as annotations, and a markdown table goes to the job
 * summary. This file is pure apart from `appendStepSummary`.
 *
 * A finding's text comes from a model reading an untrusted pull request, so it
 * is never printed raw: the runner reads a workflow command from any line that
 * starts with `::`, and a body that carried such a line could mask a secret or
 * end the step's commands. Every finding is one escaped line, and nothing else
 * from the review is printed to stdout in this mode. */
import { appendFileSync } from "node:fs";
import { formatRunSummary, type RunSummary } from "../util/run_summary.ts";
import {
  humanShortTitle,
  sortHumanFindings,
  type HumanFinding,
} from "./review_result.ts";

/** GitHub shows at most this many error and this many warning annotations per
 * step and drops the rest without a word. */
export const MAX_ANNOTATIONS_PER_LEVEL = 10;

/** The message part of a workflow command. GitHub's own toolkit escapes exactly
 * these three, and a `:` or `,` here would show as `%3A` and `%2C` in the text. */
export function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** A property value (`file`, `title`) also cannot hold `:` or `,`, which end it. */
export function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function annotation(row: HumanFinding): string {
  const properties: string[] = [];
  if (row.path) {
    properties.push(`file=${escapeProperty(row.path)}`);
    const from = row.lineFrom ?? 0;
    if (from > 0) {
      properties.push(`line=${from}`);
      const to = row.lineTo ?? from;
      if (to > from) properties.push(`endLine=${to}`);
    }
  }
  const short = humanShortTitle(row);
  properties.push(
    `title=${escapeProperty(short ? `${row.severity}: ${short}` : `${row.severity} finding`)}`,
  );
  const level = row.blocking ? "error" : "warning";
  return `::${level} ${properties.join(",")}::${escapeData(row.body || row.title)}`;
}

function active(findings: HumanFinding[]): HumanFinding[] {
  return sortHumanFindings(findings).filter((row) => row.state !== "closed");
}

/** One workflow command per finding still standing, errors first. A finding
 * that was closed since the last review needs no annotation. */
export function githubAnnotations(findings: HumanFinding[]): string[] {
  const rows = active(findings);
  const errors = rows.filter((row) => row.blocking);
  const warnings = rows.filter((row) => !row.blocking);
  const shown = [
    ...errors.slice(0, MAX_ANNOTATIONS_PER_LEVEL),
    ...warnings.slice(0, MAX_ANNOTATIONS_PER_LEVEL),
  ];
  const lines = shown.map(annotation);
  const left = rows.length - shown.length;
  if (left > 0) {
    lines.push(
      `::notice title=co-maintainer::${escapeData(
        `${left} more ${left === 1 ? "finding is" : "findings are"} not annotated, GitHub shows ${MAX_ANNOTATIONS_PER_LEVEL} errors and ${MAX_ANNOTATIONS_PER_LEVEL} warnings per step. The job summary lists all of them.`,
      )}`,
    );
  }
  return lines;
}

/** Markdown for a table cell: nothing the model wrote can become a link, an
 * image, a tag or an extra column. */
function cell(value: string, limit = 300): string {
  const flat = value.replace(/\s+/g, " ").trim();
  const cut = flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
  return cut.replace(/[\\`*_{}[\]<>|]/g, "\\$&");
}

function where(row: HumanFinding): string {
  if (!row.path) return "";
  const from = row.lineFrom ?? 0;
  const to = row.lineTo ?? from;
  const span = from <= 0 ? "" : from === to ? `:${from}` : `:${from}-${to}`;
  return cell(`${row.path}${span}`, 120);
}

export type GithubSummaryInput = {
  /** What was reviewed, for the line under the heading. */
  title: string;
  findings: HumanFinding[];
  /** Cost and time, in the same words the terminal uses. Left out when the run
   * cannot say. */
  run?: RunSummary;
};

export function githubSummary(input: GithubSummaryInput): string {
  const rows = active(input.findings);
  const closed = input.findings.filter((row) => row.state === "closed").length;
  const blocking = rows.filter((row) => row.blocking).length;
  const lines = ["## co-maintainer review", "", cell(input.title, 200), ""];
  if (rows.length === 0) {
    lines.push("No actionable findings.");
  } else {
    lines.push("| Severity | State | Where | Finding |", "|---|---|---|---|");
    for (const row of rows) {
      const short = humanShortTitle(row);
      const text = [short, row.body.split("\n")[0] ?? ""]
        .filter(Boolean)
        .join(": ");
      lines.push(
        `| ${cell(row.severity, 10)}${row.blocking ? " (blocking)" : ""} | ${row.state} | ${where(row)} | ${cell(text || row.title)} |`,
      );
    }
  }
  lines.push(
    "",
    `**Summary:** ${rows.filter((r) => r.state === "new").length} new · ${rows.filter((r) => r.state === "open").length} open · ${closed} closed · ${blocking} blocking`,
  );
  if (input.run) lines.push("", formatRunSummary(input.run));
  return lines.join("\n");
}

/** Appends to `$GITHUB_STEP_SUMMARY` when it is set. A summary that cannot be
 * written is reported on stderr and never fails the review. */
export function appendStepSummary(
  markdown: string,
  path: string | undefined = process.env.GITHUB_STEP_SUMMARY,
): void {
  if (!path) return;
  try {
    appendFileSync(path, `${markdown}\n`);
  } catch (error) {
    console.error(`Could not write the job summary: ${String(error)}`);
  }
}

/** The whole `--output=github` output of one finished review. */
export function emitGithubOutput(input: GithubSummaryInput): void {
  for (const line of githubAnnotations(input.findings)) console.log(line);
  appendStepSummary(githubSummary(input));
}

/** Progress lines that come from somewhere else (the server's job log) are
 * printed on stderr, and the runner reads workflow commands from stderr too.
 * A line that would start one is given a prefix so it stays plain text. */
export function neutralizeCommands(text: string): string {
  // The runner also ends a line at a bare carriage return.
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => (line.trimStart().startsWith("::") ? `[log] ${line}` : line))
    .join("\n");
}
