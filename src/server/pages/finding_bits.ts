/** How a finding reads wherever the dashboard lists one: its severity, its
 * state, and its links to GitHub. The PR page and the Findings lists share
 * these, so a finding looks the same in both. */
import { SEVERITY_LEGEND } from "../../pr/review_copy.ts";
import { escapeHtml, text } from "./layout.ts";
import { badge, type Tone } from "./ui.ts";

/** P0..P3 in legend order, with the tone of their badge. */
export const SEVERITY_TONE: Record<string, Tone> = {
  P0: "red",
  P1: "red",
  P2: "amber",
  P3: "neutral",
};

/** "Critical", "High", "Medium", "Low", the words the PR comment uses. */
/** A finding's title without its leading `[P1 · blocking]` bracket, for a
 * row that already shows severity and blocking as badges. A title without
 * the bracket comes back as it is. */
export function displayTitle(title: string): string {
  return title.replace(/^\s*\[P\d[^\]]*\]\s*/, "") || title;
}

export function severityName(level: string): string {
  return SEVERITY_LEGEND.find((entry) => entry.level === level)?.name ?? level;
}

export function severityBadge(level: string): string {
  return badge(SEVERITY_TONE[level] ?? "neutral", severityName(level));
}

/** Open or closed, as the finding stands in its round. */
export function isOpenFinding(state: string | null | undefined): boolean {
  return state !== "closed";
}

const CLOSE_REASON: Record<string, string> = {
  fixed: "Fixed",
  file_reverted: "File reverted",
  withdrawn: "Withdrawn, the bot agreed it was wrong",
};

/** A badge for every finding, so a closed one says so on its own line, with
 * why it closed when that is known. */
export function stateBadge(
  state: string | null | undefined,
  closeReason: string | null | undefined,
): string {
  if (isOpenFinding(state)) return badge("amber", "Open");
  const why = closeReason ? CLOSE_REASON[closeReason] : undefined;
  return `${badge("neutral", "Closed")}${
    why ? ` <span class="muted" style="font-size:13px">${text(why)}</span>` : ""
  }`;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** `path:line` as a link to that line on GitHub at the round's commit, or
 * plain text when the round has no commit. */
export function locationLink(
  fullName: string,
  sha: string | null | undefined,
  finding: {
    path: string | null;
    line_from: number | null;
    line_to: number | null;
  },
): string {
  if (!finding.path) return "";
  const label = `${finding.path}${finding.line_from ? `:${finding.line_from}` : ""}`;
  if (!sha) return `<span class="mono">${text(label)}</span>`;
  const from = finding.line_from;
  const to = finding.line_to;
  const anchor = from ? `#L${from}${to && to > from ? `-L${to}` : ""}` : "";
  const href = `https://github.com/${fullName}/blob/${encodeURIComponent(
    sha,
  )}/${encodePath(finding.path)}${anchor}`;
  return `<a class="mono" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text(
    label,
  )}</a>`;
}

/** The review thread the finding was posted in, or `""` when it was never
 * posted as a line comment. */
export function threadLink(
  fullName: string,
  prNumber: number | null,
  finding: {
    posted_comment_id: string | null;
    thread_comment_id: string | null;
  },
): string {
  const id = finding.posted_comment_id || finding.thread_comment_id || "";
  if (!prNumber || !/^\d+$/.test(id)) return "";
  return `<a href="https://github.com/${escapeHtml(
    fullName,
  )}/pull/${prNumber}#discussion_r${id}" target="_blank" rel="noopener noreferrer">Thread on GitHub</a>`;
}

/** The anchor of one finding on the PR page. */
export function findingAnchor(id: string): string {
  return `finding-${id}`;
}
