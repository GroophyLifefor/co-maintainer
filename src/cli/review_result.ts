import { parseFindings, type ParsedFinding } from "../pr/findings.ts";
import { readSuggestion, stripSuggestion } from "../pr/suggestion.ts";
import {
  anchorTextFromPatch,
  type ResolvedFinding,
} from "../review/carry_over.ts";
import {
  DEFAULT_REVIEW_BLOCKING,
  isBlocking,
  type ReviewBlocking,
} from "../review/blocking.ts";
import type { Revision } from "../review/revision.ts";
import { humanCopy } from "../services/review.ts";
import type { BilledTo, CostReason, CostStatus } from "../util/cost.ts";
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

/** One finding as the human renderer prints it. Local, PR and remote reviews
 * all normalize into this shape before printing, so the three modes cannot
 * drift into different products (CORE-43 / F21, F22). */
export type HumanFinding = {
  state: "new" | "open" | "closed";
  severity: string;
  blocking: boolean;
  path: string | null;
  lineFrom: number | null;
  lineTo: number | null;
  title: string;
  body: string;
  suggestion: { lineFrom: number; lineTo: number; text: string } | null;
};

/** Local and PR findings: blocking is decided here from the configured rule,
 * exactly as the exit code decides it (CORE-41). */
export function humanFindingsFromResolved(
  findings: ResolvedFinding[],
  mode: ReviewBlocking = DEFAULT_REVIEW_BLOCKING,
): HumanFinding[] {
  return findings.map((row) => {
    const suggestion = readSuggestion(row.bodyMd);
    return {
      state: row.state,
      severity: row.severity,
      blocking: isBlockingFinding(row.title, row.severity, mode),
      path: row.path,
      lineFrom: row.lineFrom,
      lineTo: row.lineTo,
      title: humanCopy(row.title),
      body: humanCopy(stripSuggestion(row.bodyMd)).trim(),
      suggestion: suggestion
        ? {
            lineFrom: suggestion.from,
            lineTo: suggestion.to,
            text: suggestion.code,
          }
        : null,
    };
  });
}

/** Remote findings already carry the server's blocking decision, so the label
 * uses that field rather than re-deriving the rule on a client that may not
 * share the server's config (CORE-41). */
export function humanFindingsFromJson(
  findings: JsonReviewFinding[],
): HumanFinding[] {
  return findings.map((row) => ({
    state: row.state,
    severity: row.severity,
    blocking: row.blocking,
    path: row.path,
    lineFrom: row.lineFrom,
    lineTo: row.lineTo,
    title: row.title,
    body: row.body.trim(),
    suggestion: row.suggestion,
  }));
}

function humanLocation(row: HumanFinding): string {
  if (!row.path) return row.title;
  const from = row.lineFrom ?? 0;
  const to = row.lineTo ?? from;
  const span = from === to ? `${from}` : `${from}-${to}`;
  return `${row.path}:${span}`;
}

/** The finding heading, as the shared header prints it. A parsed heading is
 * `[P2 · non-blocking] \`path\`: \`symbol\``. The label and the location are
 * already printed beside it, so only the symbol survives. An older heading
 * that used an em dash is still accepted, so comments posted before 0.5.0
 * stay readable. A heading with no symbol leaves nothing: printing the label
 * or the path again would repeat what the line already says (CORE-43). */
function humanShortTitle(row: HumanFinding): string {
  const withoutLabel = row.title.replace(/^\[P\d\s*·\s*[^\]]*\]\s*/, "");
  const dash = withoutLabel.indexOf(" — ");
  const tail = dash === -1 ? withoutLabel : withoutLabel.slice(dash + 3);
  const colon = tail.indexOf(": ");
  const symbol = colon === -1 ? tail : tail.slice(colon + 2);
  const clean = symbol.replace(/^`|`$/g, "").trim();
  return clean === "" || clean === row.path ? "" : clean;
}

function sortHumanFindings(rows: HumanFinding[]): HumanFinding[] {
  const stateOrder = { new: 0, open: 1, closed: 2 };
  return [...rows].sort((a, b) => {
    const ds = stateOrder[a.state] - stateOrder[b.state];
    if (ds !== 0) return ds;
    const sa = SEVERITY_RANK[a.severity] ?? 9;
    const sb = SEVERITY_RANK[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    const pa = a.path ?? "";
    const pb = b.path ?? "";
    if (pa !== pb) return pa.localeCompare(pb);
    return (a.lineFrom ?? 0) - (b.lineFrom ?? 0);
  });
}

export type HumanReviewInput = {
  /** Header line: repo, subject and mode. */
  title: string;
  /** Optional `N files · +a −b` fragment, present for a local review. */
  stats?: string;
  guideBuiltAt: string | null;
  /** `null` when the run cannot say (a server older than 0.5.0 sends no
   * codegraph block). A wrong "used" is what F23 was about, so unknown is
   * reported as unknown rather than guessed. */
  codegraphState: "used" | "disabled" | "unavailable" | null;
  findings: HumanFinding[];
  warnings?: ReviewWarning[];
};

/** The single human-readable review format (CORE-43 / F21, F22, F23). Local,
 * PR and remote reviews print this: a header naming the guide build date and
 * the codegraph state, the findings grouped by state, then one summary line.
 *
 * The severity legend and the "ask for more detail" sentence are deliberately
 * absent: a terminal has nobody to ask, and the legend is fixed noise. Both
 * stay in the GitHub comment, which is a different reader. */
export function formatHumanReview(input: HumanReviewInput): string {
  const guideBit = input.guideBuiltAt
    ? `guide built ${input.guideBuiltAt.slice(0, 10)}`
    : "guide unknown";
  const cgBit =
    input.codegraphState === "used"
      ? "codegraph used"
      : input.codegraphState === "disabled"
        ? "codegraph disabled"
        : input.codegraphState === "unavailable"
          ? "codegraph unavailable"
          : "codegraph unknown";
  const meta = [input.stats, guideBit, cgBit].filter(Boolean).join(" · ");
  const lines: string[] = [input.title, meta, ""];

  const sorted = sortHumanFindings(input.findings);
  const groups: Array<{
    label: string;
    state: HumanFinding["state"];
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
      const loc = humanLocation(row);
      const label = `[${row.severity} · ${
        row.blocking ? "blocking" : "non-blocking"
      }]`;
      const short = humanShortTitle(row);
      const head = `${group.bullet} ${loc}  ${label}${
        short ? ` \`${short}\`` : ""
      }`;
      lines.push(`  ${head}`);
      if (row.state === "closed") continue;
      if (row.body) {
        for (const part of row.body.split("\n")) lines.push(`    ${part}`);
      }
      if (row.suggestion && row.path) {
        const { lineFrom, lineTo, text } = row.suggestion;
        lines.push(
          `    Suggested replacement for ${row.path}:${lineFrom}${
            lineTo !== lineFrom ? `-${lineTo}` : ""
          }`,
        );
        lines.push("    ```");
        for (const part of text.split("\n")) lines.push(`    ${part}`);
        lines.push("    ```");
      }
    }
    lines.push("");
  }
  if (!any) {
    lines.push("No actionable findings.");
    lines.push("");
  }
  const counts = {
    new: sorted.filter((f) => f.state === "new").length,
    open: sorted.filter((f) => f.state === "open").length,
    closed: sorted.filter((f) => f.state === "closed").length,
    blocking: sorted.filter(
      (f) => (f.state === "new" || f.state === "open") && f.blocking,
    ).length,
  };
  lines.push(
    `Summary: ${counts.new} new · ${counts.open} open · ${counts.closed} closed · ${counts.blocking} blocking`,
  );
  if (input.warnings?.length) {
    lines.push("Warnings:");
    for (const w of input.warnings) lines.push(`  - ${w.message}`);
  }
  return lines.join("\n");
}

/** Local review output: the shared format plus the working-tree file stats. */
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
  return formatHumanReview({
    title: header,
    stats: `${stats.files} files · +${stats.additions} −${stats.deletions}`,
    guideBuiltAt,
    codegraphState,
    findings: humanFindingsFromResolved(findings, mode),
    warnings,
  });
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

/** `costUsd` is `null` when the cost is unknown, and `costStatus` and
 * `costNote` say why. */
export type ReviewUsage = {
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  costStatus?: CostStatus;
  costNote?: CostReason | null;
  billedTo?: BilledTo;
};

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
  usage: ReviewUsage;
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
  usage: ReviewUsage;
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
