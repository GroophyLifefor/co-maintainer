import { parseFindings, type ParsedFinding } from "../pr/findings.ts";
import { readSuggestion, stripSuggestion } from "../pr/suggestion.ts";
import {
  anchorTextFromPatch,
  type ResolvedFinding,
} from "../review/carry_over.ts";
import {
  DEFAULT_REVIEW_BLOCKING,
  impactWord,
  isBlocking,
  type ReviewBlocking,
} from "../review/blocking.ts";
import type { Revision } from "../review/revision.ts";
import { humanCopy } from "../services/review.ts";
export type ReviewWarning = { code: string; message: string };

export type JsonReviewFinding = {
  id: string;
  state: "new" | "open" | "closed";
  closeReason: "fixed" | "file_reverted" | null;
  severity: string;
  blocking: boolean;
  path: string | null;
  lineFrom: number | null;
  lineTo: number | null;
  title: string;
  body: string;
  suggestion: {
    lineFrom: number;
    lineTo: number;
    text: string;
  } | null;
};

const SEVERITY_RANK: Record<string, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export function isBlockingFinding(
  title: string,
  severity: string,
  mode: ReviewBlocking = DEFAULT_REVIEW_BLOCKING,
): boolean {
  return isBlocking(mode, { severity, text: title });
}

export function resolvedFromFirstReview(
  parsed: ParsedFinding[],
  filesByPath: Map<string, { patch: string }>,
): ResolvedFinding[] {
  return parsed.map((finding) => {
    const file = finding.path ? filesByPath.get(finding.path) : undefined;
    const anchor =
      file && finding.from
        ? anchorTextFromPatch(
            file.patch,
            finding.from,
            finding.to ?? finding.from,
          )
        : null;
    return {
      id: crypto.randomUUID(),
      state: "new",
      path: finding.path,
      lineFrom: finding.from,
      lineTo: finding.to,
      title: finding.heading || finding.path,
      bodyMd: finding.excerpt,
      anchorText: anchor,
      severity: finding.severity ?? "P2",
      carriedFromId: null,
      firstSeenReviewId: null,
    };
  });
}

function compareFindings(a: ResolvedFinding, b: ResolvedFinding): number {
  const stateOrder = { new: 0, open: 1, closed: 2 };
  const ds = stateOrder[a.state] - stateOrder[b.state];
  if (ds !== 0) return ds;
  const sa = SEVERITY_RANK[a.severity] ?? 9;
  const sb = SEVERITY_RANK[b.severity] ?? 9;
  if (sa !== sb) return sa - sb;
  const pa = a.path ?? "";
  const pb = b.path ?? "";
  if (pa !== pb) return pa.localeCompare(pb);
  return (a.lineFrom ?? 0) - (b.lineFrom ?? 0);
}

export function sortResolvedFindings(
  findings: ResolvedFinding[],
): ResolvedFinding[] {
  return [...findings].sort(compareFindings);
}

export function toJsonFinding(
  row: ResolvedFinding,
  mode: ReviewBlocking = DEFAULT_REVIEW_BLOCKING,
): JsonReviewFinding {
  const suggestion = readSuggestion(row.bodyMd);
  return {
    id: row.id,
    state: row.state,
    closeReason: row.closeReason ?? null,
    severity: row.severity,
    blocking: isBlockingFinding(row.title, row.severity, mode),
    path: row.path,
    lineFrom: row.lineFrom,
    lineTo: row.lineTo,
    title: humanCopy(row.title),
    body: humanCopy(stripSuggestion(row.bodyMd)),
    suggestion: suggestion
      ? {
          lineFrom: suggestion.from,
          lineTo: suggestion.to,
          text: suggestion.code,
        }
      : null,
  };
}

export function revisionStats(revision: Revision): {
  files: number;
  additions: number;
  deletions: number;
  truncated: boolean;
} {
  let additions = 0;
  let deletions = 0;
  for (const file of revision.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return {
    files: revision.files.length,
    additions,
    deletions,
    truncated: false,
  };
}

export function summaryCounts(
  findings: ResolvedFinding[],
  mode: ReviewBlocking = DEFAULT_REVIEW_BLOCKING,
): {
  new: number;
  open: number;
  closed: number;
  blocking: number;
} {
  let blocking = 0;
  for (const row of findings) {
    if (
      (row.state === "new" || row.state === "open") &&
      isBlockingFinding(row.title, row.severity, mode)
    ) {
      blocking++;
    }
  }
  return {
    new: findings.filter((f) => f.state === "new").length,
    open: findings.filter((f) => f.state === "open").length,
    closed: findings.filter((f) => f.state === "closed").length,
    blocking,
  };
}

export function reviewExitCodeFromResolved(
  findings: ResolvedFinding[],
  mode: ReviewBlocking = DEFAULT_REVIEW_BLOCKING,
): number {
  return summaryCounts(findings, mode).blocking > 0 ? 1 : 0;
}

function locationLabel(row: ResolvedFinding): string {
  if (!row.path) return row.title;
  const from = row.lineFrom ?? 0;
  const to = row.lineTo ?? from;
  const span = from === to ? `${from}` : `${from}-${to}`;
  return `${row.path}:${span}`;
}

function shortTitle(row: ResolvedFinding): string {
  const title = humanCopy(row.title);
  const dash = title.indexOf(" — ");
  return dash === -1
    ? title
    : title
        .slice(dash + 3)
        .replace(/^`|`$/g, "")
        .trim();
}

function impactLabel(
  row: ResolvedFinding,
  mode: ReviewBlocking = DEFAULT_REVIEW_BLOCKING,
): string {
  const blocking = isBlockingFinding(row.title, row.severity, mode);
  return `[${row.severity} · ${blocking ? "blocking" : "non-blocking"}]`;
}

/** Plan §9.1 human-readable local review output. */
export function formatHumanLocalReview(
  header: string,
  revision: Revision,
  guideBuiltAt: string | null,
  codegraphState: "used" | "disabled" | "unavailable",
  findings: ResolvedFinding[],
  warnings: ReviewWarning[],
  mode: ReviewBlocking = DEFAULT_REVIEW_BLOCKING,
): string {
  const stats = revisionStats(revision);
  const guideBit = guideBuiltAt
    ? `guide ${guideBuiltAt.slice(0, 10)}`
    : "guide unknown";
  const cgBit =
    codegraphState === "used"
      ? "codegraph used"
      : codegraphState === "disabled"
        ? "codegraph disabled"
        : "codegraph unavailable";
  const lines: string[] = [
    header,
    `${stats.files} files · +${stats.additions} −${stats.deletions} · ${guideBit} · ${cgBit}`,
    "",
  ];
  const sorted = sortResolvedFindings(findings);
  const groups: Array<{
    label: string;
    state: ResolvedFinding["state"];
    bullet: string;
  }> = [
    { label: "Closed", state: "closed", bullet: "✓" },
    { label: "Still open", state: "open", bullet: "•" },
    { label: "New", state: "new", bullet: "•" },
  ];
  let any = false;
  for (const group of groups) {
    const rows = sorted.filter((f) => f.state === group.state);
    if (rows.length === 0) continue;
    any = true;
    lines.push(`${group.label} (${rows.length})`);
    for (const row of rows) {
      const loc = locationLabel(row);
      const head = `${group.bullet} ${loc}  ${impactLabel(row, mode)} ${shortTitle(row)}`;
      lines.push(`  ${head}`);
      if (row.state !== "closed") {
        const body = humanCopy(stripSuggestion(row.bodyMd)).trim();
        if (body) {
          for (const part of body.split("\n")) {
            lines.push(`    ${part}`);
          }
          const suggestion = readSuggestion(row.bodyMd);
          if (suggestion && row.path) {
            lines.push(
              `    Suggested replacement for ${row.path}:${suggestion.from}${
                suggestion.to !== suggestion.from ? `-${suggestion.to}` : ""
              }`,
            );
            lines.push("    ```");
            for (const part of suggestion.code.split("\n")) {
              lines.push(`    ${part}`);
            }
            lines.push("    ```");
          }
        }
      }
    }
    lines.push("");
  }
  if (!any) {
    lines.push("No actionable findings.");
    lines.push("");
  }
  const counts = summaryCounts(findings, mode);
  lines.push(
    `Summary: ${counts.new} new · ${counts.open} open · ${counts.closed} closed · ${counts.blocking} blocking`,
  );
  if (warnings.length) {
    lines.push("Warnings:");
    for (const w of warnings) lines.push(`  - ${w.message}`);
  }
  return lines.join("\n");
}

/** Human-readable findings block for remote sync JSON (same shape as `toJsonFinding`). */
export function formatHumanJsonFindings(
  findings: JsonReviewFinding[],
  mode: ReviewBlocking = DEFAULT_REVIEW_BLOCKING,
): string {
  if (findings.length === 0) {
    return "## Findings\n\nNo actionable findings.";
  }
  const lines: string[] = ["## Findings", ""];
  const sorted = [...findings].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
  );
  for (const row of sorted) {
    const input = {
      severity: row.severity,
      blocked: row.blocking,
      text: row.title,
    };
    const impact = `[${row.severity} · ${impactWord(mode, input)}]`;
    let prefix = "";
    if (row.path) {
      const from = row.lineFrom ?? 0;
      const to = row.lineTo ?? from;
      const span = from === to ? `${from}` : `${from}-${to}`;
      prefix = `${row.path}:${span}  `;
    }
    lines.push(`- ${prefix}${impact} ${row.title}`);
    const body = row.body.trim();
    if (body) {
      for (const part of body.split("\n")) {
        lines.push(`  ${part}`);
      }
    }
    if (row.suggestion && row.path) {
      const { lineFrom, lineTo, text } = row.suggestion;
      lines.push(
        `  Suggested replacement for ${row.path}:${lineFrom}${
          lineTo !== lineFrom ? `-${lineTo}` : ""
        }`,
      );
      lines.push("  ```");
      for (const part of text.split("\n")) {
        lines.push(`  ${part}`);
      }
      lines.push("  ```");
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** The exit code for a remote review (CORE-41). The server already decided
 * each finding's `blocking` under its own configured rule, so the client
 * trusts that field instead of re-deriving the rule from a title: the client
 * may not even have the same config as the server. */
export function reviewExitCodeFromJsonFindings(
  findings: JsonReviewFinding[],
): number {
  return findings.some((f) => f.blocking) ? 1 : 0;
}

export type LocalReviewJsonInput = {
  repo: string;
  branch: string;
  baseLabel: string;
  revision: Revision;
  guideBuiltAt: string | null;
  codegraphState: "used" | "disabled" | "unavailable";
  codegraphReason: string | null;
  findings: ResolvedFinding[];
  warnings: ReviewWarning[];
  usage: { tokensIn: number; tokensOut: number; costUsd: number | null };
  durationMs: number;
  reviewBlocking?: ReviewBlocking;
};

export type PrReviewJsonInput = {
  repo: string;
  prNumber: number;
  markdown: string;
  guideBuiltAt: string | null;
  codegraphState: "used" | "disabled" | "unavailable";
  codegraphReason: string | null;
  usage: { tokensIn: number; tokensOut: number; costUsd: number | null };
  durationMs: number;
  reviewBlocking?: ReviewBlocking;
};

export function buildPrReviewJson(input: PrReviewJsonInput): string {
  const mode = input.reviewBlocking ?? DEFAULT_REVIEW_BLOCKING;
  const findings = resolvedFromFirstReview(
    parseFindings(input.markdown),
    new Map(),
  );
  const sorted = sortResolvedFindings(findings);
  return JSON.stringify({
    schemaVersion: 1,
    ok: true,
    mode: "pr",
    subject: { repo: input.repo, branch: null, prNumber: input.prNumber },
    guide: { builtAt: input.guideBuiltAt },
    codegraph: {
      state: input.codegraphState,
      reason: input.codegraphReason,
    },
    summary: summaryCounts(findings, mode),
    findings: sorted.map((row) => toJsonFinding(row, mode)),
    warnings: [],
    usage: input.usage,
    durationMs: input.durationMs,
  });
}

export function buildLocalReviewJson(input: LocalReviewJsonInput): string {
  const mode = input.reviewBlocking ?? DEFAULT_REVIEW_BLOCKING;
  const sorted = sortResolvedFindings(input.findings);
  return JSON.stringify({
    schemaVersion: 1,
    ok: true,
    mode: "local",
    subject: { repo: input.repo, branch: input.branch, prNumber: null },
    base: { toBranch: input.baseLabel, label: input.baseLabel },
    revision: revisionStats(input.revision),
    guide: { builtAt: input.guideBuiltAt },
    codegraph: {
      state: input.codegraphState,
      reason: input.codegraphReason,
    },
    summary: summaryCounts(input.findings, mode),
    findings: sorted.map((row) => toJsonFinding(row, mode)),
    warnings: input.warnings,
    usage: input.usage,
    durationMs: input.durationMs,
  });
}
