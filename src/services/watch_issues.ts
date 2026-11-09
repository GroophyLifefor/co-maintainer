/** The GitHub side of commit watch issues: the words co-maintainer writes,
 * opening, commenting on and closing an issue, and finding a tracked
 * finding's code again in a later commit.
 *
 * Issues are written in English. A reply to a comment is written in the
 * comment's language, which is the comment job's business, not this file's. */
import { normalizeAnchor, normalizePath } from "../review/revision.ts";
import { stripSuggestion } from "../pr/suggestion.ts";
import { redact } from "../util/redact.ts";
import type { GitHubClient, Json } from "../types.ts";

export const ISSUE_LABEL = "co-maintainer";
export const ISSUE_SEVERITIES = new Set(["P0", "P1"]);

export const CLOSE_DENIED_COMMENT =
  "I tried to close this issue, but I do not have permission to close issues in this repository.";

export const NOTED_REPLY =
  "Noted, I will take this into account on the next sync.";

const LABEL_COLORS: Record<string, string> = {
  [ISSUE_LABEL]: "1f883d",
  "cm-P0": "b60205",
  "cm-P1": "d93f0b",
};

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** `abc1234..def5678`, the range a push review covered. */
export function pushRange(before: string, after: string): string {
  return `${shortSha(before)}..${shortSha(after)}`;
}

export function findingMarker(id: string): string {
  return `<!-- co-maintainer:finding ${id} -->`;
}

/** Model text goes to a public issue, so a secret it quoted is masked and a
 * suggestion block, which only makes sense on a diff, is dropped. */
function clean(text: string): string {
  return redact(stripSuggestion(text)).trim();
}

/** The finding in a few words, for the issue title and for later prompts:
 * the body's first line, which the review writes as one sentence naming the
 * defect. The heading (`[P1 · blocking] \`path\`: \`symbol\``) is the
 * fallback. */
export function findingSummary(heading: string, body: string): string {
  const first = clean(body)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const text =
    first ??
    clean(heading)
      .replace(/^\[P[0-3][^\]]*\]\s*/, "")
      .replace(/`/g, "");
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

export function issueTitle(severity: string, summary: string): string {
  return `[${severity}] ${summary}`;
}

export function permalink(
  repo: string,
  sha: string,
  path: string,
  from: number | null,
  to: number | null,
): string {
  const lines =
    from && from > 0
      ? to && to > from
        ? `#L${from}-L${to}`
        : `#L${from}`
      : "";
  return `https://github.com/${repo}/blob/${sha}/${path}${lines}`;
}

export function issueBody(input: {
  id: string;
  body: string;
  repo: string;
  after: string;
  before: string;
  branch: string;
  path: string | null;
  lineFrom: number | null;
  lineTo: number | null;
}): string {
  const where = input.path
    ? permalink(
        input.repo,
        input.after,
        input.path,
        input.lineFrom,
        input.lineTo,
      )
    : "the whole push";
  return [
    clean(input.body),
    "",
    `**Where:** ${where}`,
    `**Push:** \`${pushRange(input.before, input.after)}\` on \`${input.branch}\``,
    "",
    "Feel free to ask questions here if you need more detail.",
    "",
    "Opened by co-maintainer commit watch review.",
    findingMarker(input.id),
  ].join("\n");
}

/** `commit` changed the finding's lines, `after` is the push. When they are
 * the same commit it is written once. */
export function stillFoundComment(
  commit: string,
  after: string,
  range: string,
): string {
  const where =
    shortSha(commit) === shortSha(after)
      ? shortSha(commit)
      : `${shortSha(commit)} (push ${shortSha(after)})`;
  return `change in ${where}: changed, still found by the review of ${range}`;
}

export function fixedComment(commit: string, range: string): string {
  return `change in ${shortSha(commit)}: changed, no longer found by the review of ${range}. Closing.`;
}

export function closedStillFoundComment(range: string): string {
  return `This issue was closed, but the review of push ${range} still finds the problem. If there is something I should know, please leave it as a comment.`;
}

function write(client: GitHubClient, endpoint: string, body: unknown) {
  if (!client.write) throw new Error("this GitHub client cannot post");
  return client.write<Json>(endpoint, body);
}

/** Creates each label the issue needs. A label that already exists answers
 * 422, which is fine. */
export async function ensureLabels(
  client: GitHubClient,
  repo: string,
  names: string[],
): Promise<void> {
  for (const name of names) {
    try {
      await write(client, `repos/${repo}/labels`, {
        name,
        color: LABEL_COLORS[name] ?? "ededed",
        description: "co-maintainer commit watch",
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 422) throw error;
    }
  }
}

export async function openIssue(
  client: GitHubClient,
  repo: string,
  input: { title: string; body: string; severity: string },
): Promise<number> {
  const labels = [ISSUE_LABEL, `cm-${input.severity}`];
  await ensureLabels(client, repo, labels);
  const created = await write(client, `repos/${repo}/issues`, {
    title: input.title,
    body: input.body,
    labels,
  });
  const number = Number(created.number ?? 0);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("GitHub did not return the new issue's number");
  }
  return number;
}

export async function commentOnIssue(
  client: GitHubClient,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<string> {
  const posted = await write(
    client,
    `repos/${repo}/issues/${issueNumber}/comments`,
    { body },
  );
  return String(posted.id ?? "");
}

/** Closes the issue, or leaves the comment that says it could not. Returns
 * whether it closed. */
export async function closeIssue(
  client: GitHubClient,
  repo: string,
  issueNumber: number,
): Promise<boolean> {
  try {
    if (!client.patch)
      throw Object.assign(new Error("no PATCH"), { status: 403 });
    await client.patch<Json>(`repos/${repo}/issues/${issueNumber}`, {
      state: "closed",
      state_reason: "completed",
    });
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 403 && status !== 404) throw error;
    await commentOnIssue(client, repo, issueNumber, CLOSE_DENIED_COMMENT);
    return false;
  }
}

export type IssueState = { open: boolean; closedByBot: boolean };

/** Whether the issue is open on GitHub, and when closed whether a bot (this
 * App) closed it. */
export async function readIssueState(
  client: GitHubClient,
  repo: string,
  issueNumber: number,
): Promise<IssueState | undefined> {
  try {
    const issue = await client.request<Json>(
      `repos/${repo}/issues/${issueNumber}`,
    );
    const closedBy = (issue.closed_by as Json | undefined) ?? undefined;
    const login = String(closedBy?.login ?? "");
    return {
      open: issue.state === "open",
      closedByBot:
        String(closedBy?.type ?? "") === "Bot" || login.endsWith("[bot]"),
    };
  } catch {
    return undefined;
  }
}

/** A file's text at a commit (the default branch when `sha` is empty), or
 * undefined when it is gone or unreadable. */
export async function fileAt(
  client: GitHubClient,
  repo: string,
  path: string,
  sha: string,
): Promise<string | undefined> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  try {
    const query = sha ? `?ref=${sha}` : "";
    const file = await client.request<Json>(
      `repos/${repo}/contents/${encoded}` + query,
    );
    if (typeof file.content !== "string") return undefined;
    return Buffer.from(file.content, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

/** The newest commit at or before `sha` that touched `path`, which inside a
 * push that changed the file is the commit that changed it. */
export async function lastCommitFor(
  client: GitHubClient,
  repo: string,
  path: string,
  sha: string,
): Promise<string | undefined> {
  try {
    const commits = await client.request<Json[]>(
      `repos/${repo}/commits?sha=${sha}&path=${encodeURIComponent(path)}&per_page=1`,
    );
    const first = Array.isArray(commits) ? commits[0] : undefined;
    return typeof first?.sha === "string" ? first.sha : undefined;
  } catch {
    return undefined;
  }
}

/** Where `anchor` sits in `content`, the closest match to `oldFrom` when it
 * appears more than once. Blank lines are skipped on both sides, the same
 * way `normalizeAnchor` drops them. */
export function locateAnchor(
  content: string,
  anchor: string | null,
  oldFrom: number,
): { from: number; to: number } | undefined {
  if (!anchor) return undefined;
  const want = normalizeAnchor(anchor).split("\n").filter(Boolean);
  if (want.length === 0) return undefined;
  const lines = content
    .split("\n")
    .map((text, index) => ({
      number: index + 1,
      text: text.trim().replace(/\s+/g, " "),
    }))
    .filter((line) => line.text);
  let best: { from: number; to: number; distance: number } | undefined;
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (lines[i + j]!.text !== want[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const from = lines[i]!.number;
    const to = lines[i + want.length - 1]!.number;
    const distance = Math.abs(from - oldFrom);
    if (!best || distance < best.distance) best = { from, to, distance };
  }
  return best ? { from: best.from, to: best.to } : undefined;
}

/** The new-file line numbers a patch adds or changes. */
export function changedLines(patch: string): Set<number> {
  const changed = new Set<number>();
  let next = 0;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === 0) continue;
    if (text.startsWith("+")) changed.add(next++);
    else if (text.startsWith("-")) {
      // A removed line changes the place where it was.
      changed.add(next);
    } else if (!text.startsWith("\\")) next++;
  }
  return changed;
}

/** The finding's code with line numbers and a few lines around it, for the
 * known-issue check. */
export function excerpt(content: string, from: number, to: number): string {
  const lines = content.split("\n");
  const start = Math.max(1, from - 5);
  const end = Math.min(lines.length, Math.max(from, to) + 5);
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    out.push(`${String(n).padStart(6)} ${lines[n - 1] ?? ""}`);
  }
  return out.join("\n");
}

export function samePath(a: string | null, b: string | null): boolean {
  return Boolean(a && b && normalizePath(a) === normalizePath(b));
}
