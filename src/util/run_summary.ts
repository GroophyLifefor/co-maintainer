/** The one-line cost and time summary every AI command ends with (CORE-26).
 *
 * F18: the JSON already carried `usage.costUsd` and a duration, but the human
 * output had neither and `init` printed no total at all, so the only place to
 * see what a run cost was the OpenRouter dashboard. This renders the same
 * numbers as a single stderr line:
 *
 *   `Done in 21.0s · 3,125 in, 1,308 out tokens · $0.0016`
 *
 * stdout is untouched; this is progress/diagnostic output, and mixing it into
 * stdout would corrupt `--json` and any piped text. When the provider does not
 * report a cost the dollar field is `cost unknown` rather than `$0.0000`.
 */
import type { AiMetrics } from "../services/setup.ts";
import { hasLogSink, log } from "./log.ts";
import { costReasonText, settle, type CostTally } from "./cost.ts";

export type RunSummary = {
  /** Wall-clock milliseconds, or null when only the AI time is known. */
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  /** `null` when any call left the cost unknown, matching `usage.costUsd`. */
  costUsd: number | null;
  /** Why the cost is unknown, as a sentence. */
  costNote?: string;
};

/** `3,125` — grouped the way the numbers read in the docs. */
function group(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** `21.0s`, `1.3s`, `2m 03s`; one decimal below a minute, whole seconds above. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

/** The whole line, without a trailing newline. */
export function formatRunSummary(summary: RunSummary): string {
  const parts: string[] = [];
  if (summary.durationMs !== null) {
    parts.push(`Done in ${formatDuration(summary.durationMs)}`);
  }
  parts.push(
    `${group(summary.tokensIn)} in, ${group(summary.tokensOut)} out tokens`,
  );
  parts.push(
    summary.costUsd === null
      ? `cost unknown${summary.costNote ? ` (${summary.costNote})` : ""}`
      : `$${summary.costUsd.toFixed(4)}`,
  );
  return parts.join(" · ");
}

/** Formats and writes the summary. To stderr for the CLI; inside a dashboard
 * job (no stderr) it goes to the job log instead. It prints even when the run
 * made no AI call, because a cache-hit `sync` that cost nothing is a fact the
 * user asked for, not a reason to stay silent. */
export function printRunSummary(summary: RunSummary): void {
  const line = formatRunSummary(summary);
  if (hasLogSink()) log("done", line);
  else console.error(line);
}

/** The metrics half of a summary, so call sites do not repeat the spread. */
export function summaryFromMetrics(
  metrics: AiMetrics,
  durationMs: number | null,
): RunSummary {
  const outcome = settle(metrics);
  return {
    durationMs,
    tokensIn: metrics.tokensIn,
    tokensOut: metrics.tokensOut,
    costUsd: outcome.status === "known" ? outcome.usd : null,
    ...(outcome.status === "unknown"
      ? { costNote: costReasonText(outcome.reason) }
      : {}),
  };
}

/** `0.0016` for a known cost, `unknown` otherwise. For the timing log line. */
export function costLabel(metrics: CostTally): string {
  const outcome = settle(metrics);
  return outcome.status === "known" ? outcome.usd.toFixed(4) : "unknown";
}
