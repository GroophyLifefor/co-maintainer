/** The extensions' part of one finished review, in the shape every output
 * reads: the results as they came back, and their findings with a state.
 *
 * A finding with a `key` is tracked across rounds. Seen again means still
 * open, missing from a run that returned `ok` means closed. A finding with no
 * key gets a fresh id each run and is never closed. The AI review's own
 * carry-over is not touched: its output is not deterministic, so stable keys
 * would not fit it. */
import type { ExtensionResult } from "./runner.ts";
import type { ExtensionFindingInput, Severity } from "./schema.ts";

export type ExtensionFindingState = "new" | "open" | "closed";

export type ExtensionFinding = {
  id: string;
  /** The registered name of the extension that reported it. */
  extensionId: string;
  key: string | null;
  state: ExtensionFindingState;
  severity: Severity;
  /** The finding's own flag, as the extension sent it. */
  blocking: boolean;
  title: string;
  body: string;
  path: string | null;
  lineFrom: number | null;
  lineTo: number | null;
};

/** A tracked finding from an earlier round, as the stores keep it. */
export type PreviousExtensionFinding = Omit<ExtensionFinding, "state">;

export type ExtensionReport = {
  results: ExtensionResult[];
  findings: ExtensionFinding[];
};

export const EMPTY_REPORT: ExtensionReport = { results: [], findings: [] };

export function hasExtensions(report: ExtensionReport): boolean {
  return report.results.length > 0;
}

function fromInput(
  extensionId: string,
  input: ExtensionFindingInput,
  state: ExtensionFindingState,
  id: string,
): ExtensionFinding {
  return {
    id,
    extensionId,
    key: input.key ?? null,
    state,
    severity: input.severity,
    blocking: input.blocking,
    title: input.title,
    body: input.body,
    path: input.path ?? null,
    lineFrom: input.lineFrom ?? null,
    lineTo: input.lineTo ?? input.lineFrom ?? null,
  };
}

/** Joins this round's results with the keyed findings of the last round each
 * extension returned `ok`. An extension that did not return `ok` this time
 * closes nothing: a crash is not evidence that a problem went away. */
export function buildReport(
  results: ExtensionResult[],
  previous: PreviousExtensionFinding[] = [],
): ExtensionReport {
  const findings: ExtensionFinding[] = [];
  for (const result of results) {
    if (result.status !== "ok") continue;
    const before = new Map(
      previous
        .filter((row) => row.extensionId === result.name && row.key)
        .map((row) => [row.key!, row]),
    );
    const seen = new Set<string>();
    for (const input of result.findings) {
      if (input.key && !seen.has(input.key)) {
        seen.add(input.key);
        const earlier = before.get(input.key);
        findings.push(
          fromInput(
            result.name,
            input,
            earlier ? "open" : "new",
            earlier?.id ?? crypto.randomUUID(),
          ),
        );
        continue;
      }
      findings.push(fromInput(result.name, input, "new", crypto.randomUUID()));
    }
    for (const [key, row] of before) {
      if (!seen.has(key)) findings.push({ ...row, state: "closed" });
    }
  }
  return { results, findings };
}

/** What the next round compares against: the keyed findings still standing,
 * per extension that returned `ok`, and the earlier set for one that did not. */
export function nextPrevious(
  report: ExtensionReport,
  previous: PreviousExtensionFinding[] = [],
): PreviousExtensionFinding[] {
  const okNames = new Set(
    report.results
      .filter((result) => result.status === "ok")
      .map((result) => result.name),
  );
  const kept = previous.filter((row) => !okNames.has(row.extensionId));
  const current = report.findings
    .filter((row) => row.key && row.state !== "closed")
    .map(({ state: _state, ...row }) => row);
  return [...kept, ...current];
}

/** An extension's `request_changes` makes the review Request changes, and a
 * verdict always wins over a finding's own `blocking`: a blocking finding from
 * an extension that says `comment` does not block. */
export function requestsChanges(result: ExtensionResult): boolean {
  return result.status === "ok" && result.verdict === "request_changes";
}

export function effectiveBlocking(
  report: ExtensionReport,
  finding: ExtensionFinding,
): boolean {
  if (!finding.blocking || finding.state === "closed") return false;
  const result = report.results.find((row) => row.name === finding.extensionId);
  return result !== undefined && requestsChanges(result);
}

/** Whether the extensions alone make the review blocking. */
export function extensionsBlock(report: ExtensionReport): boolean {
  return report.results.some(requestsChanges);
}

/** A review's exit code with the extensions joined in: one extension's
 * `request_changes` makes it blocking (1). A failure never does. */
export function exitCodeWithExtensions(
  code: number,
  report: ExtensionReport | undefined,
): number {
  return code === 0 && report && extensionsBlock(report) ? 1 : code;
}

/** `[P2 · blocking] · extension: secret`, the label every output uses. */
export function extensionLabel(
  report: ExtensionReport,
  finding: ExtensionFinding,
): string {
  const blocking = effectiveBlocking(report, finding)
    ? "blocking"
    : "non-blocking";
  return `[${finding.severity} · ${blocking}] · extension: ${finding.extensionId}`;
}

export function namesWith(
  report: ExtensionReport,
  status: ExtensionResult["status"],
): string[] {
  return report.results
    .filter((result) => result.status === status)
    .map((result) => result.name);
}

/** The sum of the costs the extensions reported. Unreported costs count as
 * nothing: a linter that uses no AI costs nothing. */
export function extensionsCostUsd(report: ExtensionReport): number {
  return report.results.reduce(
    (sum, result) => sum + (result.usage?.costUsd ?? 0),
    0,
  );
}
