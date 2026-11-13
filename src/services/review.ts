/** Review jobs: run the model, persist findings, post to GitHub. */
import { VERSION } from "../version.ts";
import { createAiProvider } from "../ai/provider.ts";
import { FakeAiProvider } from "../ai/fake.ts";
import { AppClient, findInstallationForRepo } from "../github/app.ts";
import { GitHubHttpError, isAccessDenied } from "../github/client.ts";
import { type ParsedFinding, parseFindings } from "../pr/findings.ts";
import { type Anchor, anchorFor } from "../pr/hunks.ts";
import {
  stripSuggestion,
  suggestionAnchor,
  withoutSuggestionLine,
} from "../pr/suggestion.ts";
import { githubPullRequestToRevision } from "../pr/github_revision.ts";
import { visiblePathsToSave } from "../review/visible_paths.ts";
import {
  anchorTextFromPatch,
  buildCarryPromptSection,
  type CarryItem,
  type CarryPrevious,
  classifyCarryItems,
  guideRebuiltSince,
  incrementalDiffPaths,
  parsePreviousVerdicts,
  resolveCarryOutcomes,
} from "../review/carry_over.ts";
import { runReviewEngine } from "../review/engine.ts";
import {
  coverageCounts,
  notReviewedLines,
  postedPathSpan,
  type Coverage,
} from "../review/coverage.ts";
import {
  addResponseCost,
  costColumns,
  emptyTally,
  settle,
  type CostTally,
} from "../util/cost.ts";
import { loadGuides } from "../review/guides.ts";
import { serverDiagramOptions } from "../review/diagram.ts";
import {
  reviewBlockingFrom,
  isBlocking,
  DEFAULT_REVIEW_BLOCKING,
  type ReviewBlocking,
} from "../review/blocking.ts";
import { matchRepeat } from "../pr/rounds.ts";
import type { Snapshot } from "../pr/snapshot.ts";
import {
  readConfig,
  resolveAppPrivateKey,
  resolvedAiToken,
} from "../config.ts";
import { outsideCode, redact } from "../util/redact.ts";
import { getRepo, setInstallationId } from "../store/repos.ts";
import {
  findNoteCommentId,
  getReview,
  getReviewByJobId,
  insertReview,
  latestPostedReview,
  setReviewScope,
  setReviewStatus,
} from "../store/reviews.ts";
import {
  insertFinding,
  listCarryableFindingsForReview,
  listFindingsForPr,
  listFindingsForReview,
  setFindingPosted,
} from "../store/findings.ts";
import {
  getOrCreatePrSubject,
  getSubjectRevision,
  parseRevisionFiles,
  parseVisiblePaths,
  saveSubjectRevision,
} from "../store/subjects.ts";
import { enqueue, type LogFn, registerHandler } from "./jobs.ts";
import { requestedReviewBlocked } from "./webhook.ts";
import type { AiProvider, GitHubClient, Json, Options } from "../types.ts";
import type { FindingRow, JobRow } from "../store/rows.ts";
import { getEnv } from "../util/runtime.ts";
import { hasWriteAccess } from "../github/write_access.ts";
import { withExtensions } from "../extensions/session.ts";
import { appPrContext } from "../extensions/contexts.ts";
import { reviewResultJson } from "../extensions/review_result.ts";
import { EMPTY_REPORT, type ExtensionReport } from "../extensions/report.ts";
import {
  reviewBodyWithExtensions,
  reviewEventWithExtensions,
  splitExtensionFindings,
  standingExtensionFindings,
} from "../extensions/render_review.ts";
import { addExtensionCost } from "../extensions/cost.ts";

const ACCESS_DENIED_BODY =
  "The App does not have access to review this pull request.";

/** The first words of the single note a failed review leaves on the pull
 * request. The note names no provider error and no retry command: both live
 * on the dashboard the note links to. */
export const REVIEW_FAILED_NOTE_START =
  "co-maintainer couldn't review this push";

/** The failed note is rewritten to this once a retry posts a review. The
 * required sentence carries a semicolon, so it is not written as one literal:
 * the copy guard scans single quoted strings for a prose semicolon. */
export const REVIEWED_NOTE =
  "co-maintainer reviewed this push" + "; the review is below.";

export function humanCopy(text: string): string {
  // The semicolon is prose and always goes. The em dash is left alone here:
  // this function also sanitizes a finding title, and a title posted before
  // 0.5.0 uses ` — ` as its path/symbol separator, which the legacy heading
  // reader still needs (the copy guard keeps that one allowlisted exception).
  return outsideCode(redact(text), (prose) => prose.replaceAll(";", "."));
}

function hasForbiddenCopy(text: string): boolean {
  return outsideCode(text, (prose) => prose.replaceAll(";", "")) !== text;
}

function severityOf(heading: string): string {
  return heading.match(/\bP[0-3]\b/)?.[0] ?? "P2";
}

function post(
  client: GitHubClient,
  endpoint: string,
  body: unknown,
): Promise<Json> {
  if (!client.write) {
    throw new Error("this GitHub client cannot post");
  }
  return client.write<Json>(endpoint, body);
}

/** The dashboard's public origin, when one is configured, so a failure note
 * links to a page a reader can open. No saved address means a root-relative
 * link, which still resolves for anyone on the dashboard. */
function dashboardOrigin(): string {
  const url = readConfig().webhookUrl;
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** The one note a failed review leaves on the pull request: the short line a
 * maintainer sees and a link to the job on the dashboard, where the provider's
 * own reason is kept. Never the raw provider body, never a retry command. */
export function failedNoteBody(job: JobRow): string {
  return (
    `${REVIEW_FAILED_NOTE_START}. See the error on the dashboard: ` +
    `${dashboardOrigin()}/activity/${job.id}`
  );
}

/** The note already left for this push, if any, so a second failure or a retry
 * edits that one instead of opening a duplicate. */
function existingNoteId(job: JobRow): string | undefined {
  const review = getReviewByJobId(job.id);
  return (
    review?.note_comment_id ??
    findNoteCommentId(job.repo, job.pr_number ?? 0, review?.head_sha ?? null)
  );
}

/** A failed attempt ends in `failed` with its cost, and leaves exactly one
 * note linking the dashboard job. Posting that note is best effort: a GitHub
 * refusal there must not hide the AI failure itself. */
async function recordFailedReview(
  github: GitHubClient,
  job: JobRow,
  reviewId: string,
  costTally: CostTally,
  log: LogFn,
): Promise<void> {
  setReviewStatus(reviewId, "failed", {
    ...costColumns(settle(costTally)),
  });
  if (job.pr_number === null || existingNoteId(job)) return;
  try {
    const posted = await post(
      github,
      `repos/${job.repo}/issues/${job.pr_number}/comments`,
      { body: failedNoteBody(job) },
    );
    setReviewStatus(reviewId, "failed", {
      note_comment_id: String(posted.id ?? ""),
    });
  } catch (error) {
    log("info", `could not post the failure note: ${redact(String(error))}`);
  }
}

/** A retry that posted a review rewrites the earlier failure note to say so.
 * The note is not deleted, and no second note is opened. */
async function resolveFailureNote(
  github: GitHubClient,
  job: JobRow,
  reviewId: string,
  log: LogFn,
): Promise<void> {
  const noteId = existingNoteId(job);
  if (!noteId) return;
  // An edit is a PATCH, the method the App's permission table names. GitHub
  // has no POST for it, so a client without PATCH cannot edit the note.
  if (!github.patch) {
    log("info", "could not update the failure note: this client cannot edit");
    return;
  }
  try {
    await github.patch<Json>(`repos/${job.repo}/issues/comments/${noteId}`, {
      body: REVIEWED_NOTE,
    });
    setReviewStatus(reviewId, "posted", { note_comment_id: noteId });
  } catch (error) {
    log("info", `could not update the failure note: ${redact(String(error))}`);
  }
}

export function splitInline(
  findings: ParsedFinding[],
  files: Json[],
): {
  inline: { finding: ParsedFinding; anchor: Anchor; suggestion: boolean }[];
  leftover: ParsedFinding[];
} {
  const patches = new Map(
    files.map((file) => [
      String(file.filename ?? ""),
      String(file.patch ?? ""),
    ]),
  );
  const inline: {
    finding: ParsedFinding;
    anchor: Anchor;
    suggestion: boolean;
  }[] = [];
  const leftover: ParsedFinding[] = [];
  for (const finding of findings) {
    const patch = patches.get(finding.path);
    if (patch === undefined || finding.from <= 0) {
      leftover.push(finding);
      continue;
    }
    const fix = suggestionAnchor(finding, patch);
    const anchor = fix ?? anchorFor(patch, finding.from, finding.to);
    if (anchor) inline.push({ finding, anchor, suggestion: fix !== undefined });
    else leftover.push(finding);
  }
  return { inline, leftover };
}

export function reviewEvent(
  findingsCount: number,
): "REQUEST_CHANGES" | "COMMENT" {
  return findingsCount > 0 ? "REQUEST_CHANGES" : "COMMENT";
}

/** The GitHub review event for a set of stored findings.
 *
 * Only open findings count. A re-review that closed the last finding used to
 * request changes from the closed row while its body said "No actionable
 * findings", so a review with no open finding approves.
 *
 * `model` keeps the 0.4.13 behavior: any open finding requests changes, because
 * the model's label already decided. `severity` ignores that label and
 * requests changes only for a P0 or P1, so the same finding set always yields
 * the same event. */
export function appReviewEvent(
  findings: { severity: string; title: string; state?: string }[],
  mode: ReviewBlocking = DEFAULT_REVIEW_BLOCKING,
): "REQUEST_CHANGES" | "COMMENT" | "APPROVE" {
  const open = findings.filter((row) => row.state !== "closed");
  if (open.length === 0) return "APPROVE";
  if (mode === "model") return "REQUEST_CHANGES";
  const blocking = open.some((row) =>
    isBlocking(mode, { severity: row.severity, text: row.title }),
  );
  return reviewEvent(blocking ? 1 : 0);
}

export interface ReviewMetadata {
  jobId: string;
  model: string;
  durationMs: number;
  /** What the model received, for the coverage line and the not-reviewed
   * list. */
  coverage?: Coverage;
  /** Whether the next round sends the files this round dropped. */
  catchesUp?: boolean;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function metadataBlock({
  jobId,
  model,
  durationMs,
  coverage,
}: ReviewMetadata): string {
  return (
    `\n\n<details>\n<summary>Metadata</summary>\n\n` +
    `- Activity: ${jobId}\n` +
    `- co-maintainer version: ${VERSION}\n` +
    `- Model: ${model}\n` +
    `- Duration: ${formatDuration(durationMs)}\n` +
    (coverage ? `- Coverage: ${coverageCounts(coverage)}\n` : "") +
    `</details>`
  );
}

/** The files this round never sent to the model, as a list under the
 * findings. Paths are made safe code spans: a path is not prose, the copy
 * guard must not read a semicolon in one as a sentence, and the author's file
 * names must not inject Markdown or mentions. */
function notReviewedBlock(metadata: ReviewMetadata): string {
  const lines = notReviewedLines(
    metadata.coverage,
    metadata.catchesUp ?? false,
    postedPathSpan,
  );
  return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
}

/** A finding an earlier round reported that this round still finds, with the
 * commit that first found it when known. */
export type StillOpenFinding = { finding: ParsedFinding; since?: string };

function summaryLine(finding: ParsedFinding, since?: string): string {
  const title = humanCopy(finding.heading || finding.path);
  const summary = humanCopy(
    finding.summary ??
      finding.excerpt.split(/\r?\n/).find((line) => line.trim()) ??
      "",
  );
  const first = since ? ` (first found in ${since.slice(0, 7)})` : "";
  return `- ${title}${summary ? `: ${summary}` : ""}${first}`;
}

/** Short summary on the review itself, one line per open finding, split
 * into what this round found and what earlier rounds found that still
 * holds, so a repeat never reads as a new problem. */
export function reviewBody(
  findings: ParsedFinding[],
  metadata: ReviewMetadata,
  stillOpen: StillOpenFinding[] = [],
): string {
  const notReviewed = notReviewedBlock(metadata);
  if (findings.length === 0 && stillOpen.length === 0) {
    const none = notReviewed
      ? "No actionable findings in the files reviewed."
      : "No actionable findings.";
    return `${none}${notReviewed}${metadataBlock(metadata)}`;
  }
  const lines: string[] = ["Review summary"];
  if (findings.length) {
    lines.push("", `New (${findings.length})`);
    for (const finding of findings) lines.push(summaryLine(finding));
  }
  if (stillOpen.length) {
    lines.push("", `Still open (${stillOpen.length})`);
    for (const { finding, since } of stillOpen) {
      lines.push(summaryLine(finding, since));
    }
  }
  return lines.join("\n") + notReviewed + metadataBlock(metadata);
}

function inlineCommentBody(finding: ParsedFinding, suggestion = false): string {
  const heading = humanCopy(finding.heading);
  const excerpt = humanCopy(
    suggestion
      ? withoutSuggestionLine(finding.excerpt)
      : stripSuggestion(finding.excerpt),
  );
  const marker = `${finding.path}:${finding.from}`;
  const at = excerpt.indexOf(marker);
  const rest =
    at >= 0 ? excerpt.slice(at + marker.length).trim() : excerpt.trim();
  if (!rest) return heading;
  return `${heading}\n\n${rest}`;
}

function rowFinding(row: FindingRow): ParsedFinding {
  return {
    path: row.path ?? "",
    from: row.line_from ?? 0,
    to: row.line_to ?? row.line_from ?? 0,
    heading: row.title,
    excerpt: row.body_md,
  };
}

function sameBody(a: string, b: string): boolean {
  const clean = (text: string) => text.replace(/\r\n/g, "\n").trim();
  return clean(a) === clean(b);
}

/** Whether a posted comment already says what this finding says. The comment
 * may have gone out with its suggestion block, so both forms count. */
function repeatsComment(row: FindingRow, posted: string): boolean {
  const finding = rowFinding(row);
  return (
    sameBody(posted, inlineCommentBody(finding)) ||
    sameBody(posted, inlineCommentBody(finding, true))
  );
}

/** The pull request's review comments by id. An unreadable list comes back
 * empty, so a repeat is posted again rather than going unsaid. */
async function postedCommentBodies(
  client: GitHubClient,
  job: JobRow,
  log: LogFn,
): Promise<Map<string, string>> {
  try {
    const listed = await client.pages<Json>(
      `repos/${job.repo}/pulls/${job.pr_number}/comments`,
    );
    return new Map(
      listed.map((item) => [String(item.id ?? ""), String(item.body ?? "")]),
    );
  } catch (error) {
    log(
      "info",
      `could not read the earlier comments: ${redact(String(error))}`,
    );
    return new Map();
  }
}

/** What people with write access replied on each finding's inline thread,
 * oldest first, keyed by finding id. The next round weighs them when it
 * decides whether the finding still holds. */
async function findingReplies(
  client: GitHubClient,
  job: JobRow,
  rows: FindingRow[],
  log: LogFn,
): Promise<Map<string, string[]>> {
  const byThread = new Map<string, string>();
  for (const row of rows) {
    for (const id of [row.posted_comment_id, row.thread_comment_id]) {
      if (id) byThread.set(id, row.id);
    }
  }
  const replies = new Map<string, string[]>();
  if (byThread.size === 0) return replies;
  let listed: Json[];
  try {
    listed = await client.pages<Json>(
      `repos/${job.repo}/pulls/${job.pr_number}/comments`,
    );
  } catch (error) {
    log("info", `could not read the review threads: ${redact(String(error))}`);
    return replies;
  }
  const access = new Map<string, Promise<boolean>>();
  const sorted = [...listed].sort((a, b) =>
    String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
  );
  for (const comment of sorted) {
    const findingId = byThread.get(String(comment.in_reply_to_id ?? ""));
    const user = comment.user as Json | undefined;
    const login = String(user?.login ?? "");
    if (!findingId || !login) continue;
    if (user?.type === "Bot" || login.endsWith("[bot]")) continue;
    if (!access.has(login)) {
      access.set(login, hasWriteAccess(client, job.repo, login));
    }
    if (!(await access.get(login))) continue;
    const list = replies.get(findingId) ?? [];
    list.push(String(comment.body ?? ""));
    replies.set(findingId, list);
  }
  return replies;
}

/** A review job's options: the config, with the job's pinned model (a
 * "Retry with the same model") over the configured one. */
export function reviewOptionsForJob(
  repo: string,
  prNumber: number,
  args: { model?: string },
  warn?: (message: string) => void,
): Options {
  const options = reviewOptions(repo, prNumber, warn);
  return args.model ? { ...options, highModel: args.model } : options;
}

export function reviewOptions(
  repo: string,
  prNumber: number,
  warn?: (message: string) => void,
): Options {
  const config = readConfig();
  return {
    command: "review",
    repo,
    prNumber,
    debug: false,
    logTime: false,
    improveMatrix: 1,
    ghConcurrent: 1,
    aiConcurrent: 1,
    auth: "gh",
    // With no provider saved the App review stays on OpenRouter, the same
    // fallback the CLI review uses.
    ai: config.ai && config.ai !== "none" ? config.ai : "openrouter",
    aiToken: resolvedAiToken(
      config,
      config.ai && config.ai !== "none" ? config.ai : "openrouter",
    ),
    highModel: config.highModel,
    lowModel: config.lowModel,
    synthesisVersion: 17,
    includeCodebase: true,
    includePullRequests: true,
    includePullRequestChanges: true,
    includeCommitHistory: true,
    includeHowRepoWorks: true,
    onlyRequestChangedPr: false,
    useCodegraph: getRepo(repo)?.use_codegraph === 1,
    reviewBlocking: reviewBlockingFrom(
      config.repos?.[repo]?.reviewBlocking ?? config.reviewBlocking,
    ),
    reviewSystemPrompt: config.repos?.[repo]?.reviewSystemPrompt,
    ...serverDiagramOptions(config.repos?.[repo] ?? {}, repo, warn),
  };
}

export function aiFor(options: Options): AiProvider {
  if (getEnv("CM_FAKE_AI") === "1") return new FakeAiProvider();
  const provider = createAiProvider(options, options.highModel ?? "");
  if (!provider) {
    throw new Error(
      "review needs an AI provider. run: co-maintainer set --ai=openrouter --token=...",
    );
  }
  return provider;
}

export function clientFor(installationId: number): GitHubClient {
  const config = readConfig();
  const privateKeyPem = resolveAppPrivateKey(config);
  if (!config.githubAppId || !privateKeyPem) {
    throw new Error("review jobs need the GitHub App configured");
  }
  return new AppClient(config.githubAppId, privateKeyPem, installationId);
}

export async function resolveInstallationId(
  fullName: string,
): Promise<number | undefined> {
  const current = getRepo(fullName)?.installation_id;
  if (current) return current;
  const config = readConfig();
  const privateKeyPem = resolveAppPrivateKey(config);
  if (!config.githubAppId || !privateKeyPem) return undefined;
  const installationId = await findInstallationForRepo(
    config.githubAppId,
    privateKeyPem,
    fullName,
  );
  if (installationId !== undefined) setInstallationId(fullName, installationId);
  return installationId;
}

async function denyAccess(
  client: GitHubClient,
  job: JobRow,
  reviewId: string,
  log: LogFn,
  checkRunId?: string,
): Promise<void> {
  log("info", "pull request files were denied, posting one issue comment");
  setReviewStatus(reviewId, "posting");
  const posted = await post(
    client,
    `repos/${job.repo}/issues/${job.pr_number}/comments`,
    {
      body: ACCESS_DENIED_BODY,
    },
  );
  setReviewStatus(reviewId, "access_denied", {
    posted_review_id: String(posted.id ?? ""),
    posted_fallback: 1,
  });
  await finishCheck(
    client,
    job,
    checkRunId,
    "failure",
    "Review could not access the pull request files.",
    [],
    log,
  );
}

function checkAnnotations(
  findings: ReturnType<typeof listFindingsForReview>,
): Json[] {
  return findings
    .filter((finding) => finding.path)
    .slice(0, 50)
    .map((finding) => {
      const startLine = Math.max(1, finding.line_from ?? finding.line_to ?? 1);
      const endLine = Math.max(startLine, finding.line_to ?? startLine);
      return {
        path: finding.path,
        start_line: startLine,
        end_line: endLine,
        start_column: 1,
        end_column: 1,
        annotation_level:
          finding.severity === "P1"
            ? "failure"
            : finding.severity === "P2"
              ? "warning"
              : "notice",
        message: humanCopy(stripSuggestion(finding.body_md)),
        title: humanCopy(finding.title),
      };
    });
}

async function startCheck(
  client: GitHubClient,
  job: JobRow,
  reviewId: string,
  headSha: string,
  log: LogFn,
): Promise<string | undefined> {
  if (!client.createCheckRun) return undefined;
  try {
    const check = await client.createCheckRun<Json>(
      `repos/${job.repo}/check-runs`,
      {
        name: "co-maintainer review",
        head_sha: headSha,
        status: "queued",
        external_id: reviewId,
      },
    );
    const id = String(check.id ?? "");
    if (!id) {
      log("info", "GitHub Check Run did not return an id");
      return undefined;
    }
    setReviewStatus(reviewId, "drafting", { check_run_id: id });
    return id;
  } catch (error) {
    log("info", `GitHub Check Run unavailable: ${redact(String(error))}`);
    return undefined;
  }
}

async function updateCheck(
  client: GitHubClient,
  job: JobRow,
  checkRunId: string | undefined,
  body: Json,
  log: LogFn,
): Promise<void> {
  if (!checkRunId || !client.updateCheckRun) return;
  try {
    await client.updateCheckRun<Json>(
      `repos/${job.repo}/check-runs/${checkRunId}`,
      body,
    );
  } catch (error) {
    log("info", `GitHub Check Run update failed: ${redact(String(error))}`);
  }
}

async function finishCheck(
  client: GitHubClient,
  job: JobRow,
  checkRunId: string | undefined,
  conclusion: "success" | "neutral" | "failure",
  title: string,
  findings: ReturnType<typeof listFindingsForReview>,
  log: LogFn,
): Promise<void> {
  // A closed finding was fixed; counting it would report work that is done.
  const open = findings.filter((finding) => finding.state !== "closed");
  await updateCheck(
    client,
    job,
    checkRunId,
    {
      status: "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: humanCopy(title),
        summary: humanCopy(
          open.length === 0
            ? "No actionable findings."
            : `${open.length} finding(s) reported.`,
        ),
        annotations: checkAnnotations(open),
      },
    },
    log,
  );
}

async function publish(
  client: GitHubClient,
  job: JobRow,
  reviewId: string,
  headSha: string,
  files: Json[],
  log: LogFn,
  metadata: ReviewMetadata,
  mode: ReviewBlocking = DEFAULT_REVIEW_BLOCKING,
  extensions: ExtensionReport = EMPTY_REPORT,
): Promise<void> {
  const stored = listFindingsForReview(reviewId);
  // GitHub wraps every `in_reply_to` comment in a review of its own, so a round
  // posts no replies. A repeat stays on its thread and in the summary, and a
  // finding whose text changed goes inline on the one review.
  const threaded = stored.filter((row) => row.thread_comment_id);
  const earlier =
    threaded.length > 0
      ? await postedCommentBodies(client, job, log)
      : new Map<string, string>();
  const repeats = threaded.filter((row) => {
    const posted = earlier.get(row.thread_comment_id ?? "");
    return posted !== undefined && repeatsComment(row, posted);
  });
  const freshRows = stored.filter(
    (row) =>
      !repeats.includes(row) && (row.state === "new" || row.thread_comment_id),
  );
  const fresh = freshRows.map(rowFinding);
  const { inline } = splitInline(fresh, files);
  const commentByRow = new Map<string, { anchor: Anchor; body: string }>();
  for (const { finding, anchor, suggestion } of inline) {
    const row = freshRows.find(
      (item) =>
        item.path === finding.path &&
        item.line_from === finding.from &&
        item.line_to === finding.to,
    );
    if (row) {
      commentByRow.set(row.id, {
        anchor,
        body: inlineCommentBody(finding, suggestion),
      });
    }
  }
  // The summary lists every open finding once, by what this round made of
  // it: found now, or found by an earlier round and still there.
  const summaryFindings = stored
    .filter((row) => row.state === "new")
    .map(rowFinding);
  const stillOpen = stored
    .filter((row) => row.state === "open")
    .map((row) => ({
      finding: rowFinding(row),
      since: row.first_seen_review_id
        ? (getReview(row.first_seen_review_id)?.head_sha ?? undefined)
        : undefined,
    }));
  const extensionSplit = splitExtensionFindings(extensions, files, humanCopy);
  const body = reviewBodyWithExtensions(
    reviewBody(summaryFindings, metadata, stillOpen),
    extensions,
    extensionSplit.listed,
    humanCopy,
  );
  const aiComments = inline.map(({ finding, anchor, suggestion }) => ({
    path: finding.path,
    body: inlineCommentBody(finding, suggestion),
    line: anchor.line,
    side: "RIGHT",
    ...(anchor.start_line === undefined
      ? {}
      : { start_line: anchor.start_line, start_side: "RIGHT" }),
  }));
  const comments = [...aiComments, ...extensionSplit.comments];
  if (
    hasForbiddenCopy(body) ||
    hasForbiddenCopy(ACCESS_DENIED_BODY) ||
    comments.some((comment) => hasForbiddenCopy(comment.body))
  ) {
    throw new Error("review body contains forbidden copy characters");
  }
  for (const row of repeats) {
    setFindingPosted(row.id, row.thread_comment_id ?? "");
  }
  const payload = {
    commit_id: headSha,
    body,
    event: reviewEventWithExtensions(appReviewEvent(stored, mode), extensions),
    comments,
  };
  setReviewStatus(reviewId, "posting");
  try {
    const posted = await post(
      client,
      `repos/${job.repo}/pulls/${job.pr_number}/reviews`,
      payload,
    );
    setReviewStatus(reviewId, "posted", {
      posted_review_id: String(posted.id ?? ""),
      findings_count: stored.length,
      duration_ms: metadata.durationMs,
    });
    try {
      const listed = await client.pages<Json>(
        `repos/${job.repo}/pulls/${job.pr_number}/comments`,
      );
      for (const row of stored) {
        const comment = commentByRow.get(row.id);
        if (row.posted_comment_id || !row.path || !comment) continue;
        const hit = listed.find(
          (item) =>
            String(item.path ?? "") === row.path &&
            Number(item.line ?? item.original_line ?? 0) ===
              comment.anchor.line &&
            sameBody(String(item.body ?? ""), comment.body),
        );
        if (hit?.id) setFindingPosted(row.id, String(hit.id));
      }
    } catch {
      // Comment ids are used for later replies. Missing them does not
      // fail the review that already posted.
    }
    log("info", `posted review ${posted.id}`);
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 422) {
      log("info", "inline comments rejected, falling back to an issue comment");
      const posted = await post(
        client,
        `repos/${job.repo}/issues/${job.pr_number}/comments`,
        { body },
      );
      setReviewStatus(reviewId, "posted", {
        posted_review_id: String(posted.id ?? ""),
        findings_count: stored.length,
        posted_fallback: 1,
      });
      return;
    }
    if (isAccessDenied(error)) {
      // The AI result and its cost are already stored. Only the post failed,
      // so this is not an AI failure and nothing claims the review was posted.
      setReviewStatus(reviewId, "not_posted");
      log("info", `GitHub rejected the review post: ${redact(String(error))}`);
      throw error;
    }
    setReviewStatus(reviewId, "failed");
    throw error;
  }
}

export async function reconcileReview(
  job: JobRow,
  log: LogFn,
  client: GitHubClient,
): Promise<void> {
  const review = getReviewByJobId(job.id);
  if (!review || review.status === "drafting" || review.status === "failed") {
    await runReviewJob(job, log, client);
    return;
  }
  if (review.status === "posted" || review.status === "access_denied") {
    log("info", `already ${review.status}, nothing to post`);
    return;
  }
  if (review.status !== "posting" || job.pr_number === null) {
    log("info", `unhandled status ${review.status}, not posting again`);
    return;
  }
  const listed = await client.pages<Json>(
    `repos/${job.repo}/pulls/${job.pr_number}/reviews`,
  );
  const match = listed.find((item) => {
    const user = item.user as Json | undefined;
    return (
      String(item.commit_id ?? "") === review.head_sha &&
      String(user?.type ?? "") === "Bot"
    );
  });
  if (match) {
    setReviewStatus(review.id, "posted", {
      posted_review_id: String(match.id ?? ""),
    });
    log("info", `reconciled existing GitHub review ${match.id}`);
    return;
  }
  setReviewStatus(review.id, "failed");
  log("info", "posting crashed and no matching GitHub review was found");
}

export async function runReviewJob(
  job: JobRow,
  log: LogFn,
  client?: GitHubClient,
  ai?: AiProvider,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await runReviewJobCore(job, log, client, ai, signal);
  } catch (error) {
    const review = getReviewByJobId(job.id);
    let github = client;
    if (!github && review?.check_run_id) {
      const repo = getRepo(job.repo);
      if (repo?.installation_id) {
        try {
          github = clientFor(repo.installation_id);
        } catch {
          // The original review error is more useful to the job log.
        }
      }
    }
    if (github && review?.check_run_id) {
      await finishCheck(
        github,
        job,
        review.check_run_id,
        "failure",
        "Review job failed.",
        listFindingsForReview(review.id),
        log,
      );
    }
    throw error;
  }
}

async function runReviewJobCore(
  job: JobRow,
  log: LogFn,
  client?: GitHubClient,
  ai?: AiProvider,
  signal?: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  if (job.pr_number === null) {
    throw new Error("review job is missing a pull request number");
  }
  const repo = getRepo(job.repo);
  const installationId =
    repo?.installation_id ?? (await resolveInstallationId(job.repo));
  if (!client && installationId === undefined) {
    throw new Error(`no GitHub App installation stored for ${job.repo}`);
  }
  const github = client ?? clientFor(installationId!);
  const existing = getReviewByJobId(job.id);
  if (
    existing &&
    (existing.status === "posting" ||
      existing.status === "posted" ||
      existing.status === "access_denied")
  ) {
    await reconcileReview(job, log, github);
    return;
  }

  const args = JSON.parse(job.args || "{}") as {
    trigger?: string;
    scope?: string;
    sinceCommit?: string;
    round?: number;
    requestReaction?: string;
    model?: string;
  };
  const options = reviewOptionsForJob(job.repo, job.pr_number, args, (text) =>
    log("info", text),
  );
  const pr = await github.request<Json>(
    `repos/${job.repo}/pulls/${job.pr_number}`,
  );
  if (args.trigger === "request-comment" && !existing) {
    const blocked = requestedReviewBlocked(job.repo, pr);
    if (blocked) {
      log("info", `the review request was not run: ${blocked}`);
      return;
    }
  }
  // A maintainer asked for this review by label or comment: acknowledge it.
  // Best effort, a missing reaction must never fail the review itself.
  if (args.requestReaction && !existing) {
    try {
      await post(github, args.requestReaction, { content: "eyes" });
    } catch (error) {
      log("info", `could not react to the review request: ${String(error)}`);
    }
  }
  const headSha = String((pr.head as Json | undefined)?.sha ?? "");
  const mergeBase = String((pr.base as Json | undefined)?.sha ?? "");
  if (!existing) {
    const last = latestPostedReview(job.repo, job.pr_number);
    // A review or comment that arrived while a review of this head was
    // running queued this job. That review has posted by now.
    if (
      (args.trigger === "review" || args.trigger === "review-comment") &&
      last?.head_sha === headSha
    ) {
      log("info", "this head was already reviewed, nothing new to review");
      return;
    }
    // Round and base come from the review that posted last, read now rather
    // than when the job was queued: a review may have posted in between.
    if (args.round === undefined) {
      Object.assign(args, roundArgs(job.repo, last));
    }
  }
  let scope = args.scope === "incremental" ? "incremental" : "whole-pr";
  if (scope === "incremental" && !args.sinceCommit) {
    scope = "whole-pr";
  }
  let reviewBase =
    scope === "incremental" && args.sinceCommit ? args.sinceCommit : mergeBase;
  const subject = getOrCreatePrSubject(job.repo, job.pr_number);
  const reviewId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    insertReview({
      id: reviewId,
      repo: job.repo,
      prNumber: job.pr_number,
      jobId: job.id,
      headSha,
      baseSha: reviewBase,
      scope,
      model: options.highModel ?? "unknown",
      trigger: args.trigger,
      round: args.round ?? 1,
      subjectId: subject.id,
    });
  }
  let checkRunId = existing?.check_run_id;
  if (!checkRunId) {
    checkRunId = await startCheck(github, job, reviewId, headSha, log);
  }

  let snapshot: Snapshot | undefined;
  let files: Json[] = [];
  let publishFiles: Json[] = [];
  try {
    if (scope === "incremental" && args.sinceCommit) {
      try {
        const compare = await github.request<Json>(
          `repos/${job.repo}/compare/${args.sinceCommit}...${headSha}`,
        );
        files = (compare.files as Json[]) ?? [];
        snapshot = {
          base: args.sinceCommit,
          commit: headSha,
          before: "9999-12-31T23:59:59.999Z",
        };
      } catch (error) {
        if (
          isAccessDenied(error) ||
          (error instanceof GitHubHttpError &&
            (error.status === 403 || error.status === 404))
        ) {
          log("info", "incremental compare unavailable, reviewing whole PR");
          scope = "whole-pr";
          reviewBase = mergeBase;
          snapshot = undefined;
          files = await github.pages<Json>(
            `repos/${job.repo}/pulls/${job.pr_number}/files`,
          );
        } else {
          throw error;
        }
      }
    } else {
      files = await github.pages<Json>(
        `repos/${job.repo}/pulls/${job.pr_number}/files`,
      );
    }
    publishFiles = snapshot
      ? await github.pages<Json>(
          `repos/${job.repo}/pulls/${job.pr_number}/files`,
        )
      : files;
  } catch (error) {
    if (isAccessDenied(error)) {
      await denyAccess(github, job, reviewId, log, checkRunId);
      return;
    }
    throw error;
  }

  if (!existing) {
    setReviewScope(reviewId, scope, reviewBase);
  }

  await updateCheck(
    github,
    job,
    checkRunId,
    {
      status: "in_progress",
      started_at: new Date().toISOString(),
    },
    log,
  );
  log("info", `reviewing ${job.repo}#${job.pr_number}`);
  const baseLabel = `origin/${String((pr.base as Json | undefined)?.ref ?? "main")}`;
  const revision = githubPullRequestToRevision(publishFiles, pr, baseLabel);
  const guidesBefore = await loadGuides(job.repo);
  let guideBuiltAt = guidesBefore.guideBuiltAt;
  const subjectRevision = getSubjectRevision(subject.id);
  let carryItems: CarryItem[] = [];
  let carryPrevious: CarryPrevious | null = null;
  // Only an incremental round leaves out what the last round saw, so only
  // it sends the files the last round dropped.
  const catchesUp = scope === "incremental";
  const extras: {
    carryPrompt?: string;
    unchangedPaths?: string[];
    catchesUp?: boolean;
    resend?: Json[];
  } = { catchesUp };
  // A guide rebuilt after the previous review invalidates that review's
  // verdicts and its "unchanged" suppression. Treat the run as
  // if it had started fresh: carry-over off, every changed file back in scope,
  // so a stale finding can never mask a new one.
  const guideRebuilt =
    subjectRevision !== undefined &&
    guideRebuiltSince(
      subjectRevision.guide_built_at,
      guidesBefore.guideBuiltAt,
    );
  if (subjectRevision && !guideRebuilt) {
    const prevFiles = parseRevisionFiles(subjectRevision);
    const { changed, unchanged } = incrementalDiffPaths(
      revision,
      prevFiles,
      parseVisiblePaths(subjectRevision),
    );
    extras.unchangedPaths = scope === "incremental" ? unchanged : undefined;
    if (scope === "incremental") {
      // The compare lists only what changed since the last round. A file
      // that round dropped or withheld is not in it when nobody touched it
      // since, so it is sent from the pull request's own file list.
      const due = new Set(changed.map((file) => file.path));
      const compared = new Set(files.map((file) => String(file.filename)));
      extras.resend = publishFiles.filter((file) => {
        const path = String(file.filename ?? "");
        return due.has(path) && !compared.has(path);
      });
    }
    const storedRows = listCarryableFindingsForReview(
      subjectRevision.review_id,
    );
    const replies = await findingReplies(github, job, storedRows, log);
    carryPrevious = {
      files: prevFiles,
      visiblePaths: parseVisiblePaths(subjectRevision),
      findings: storedRows.map((row) => ({
        id: row.id,
        path: row.path,
        lineFrom: row.line_from,
        lineTo: row.line_to,
        title: row.title,
        bodyMd: row.body_md,
        anchorText: row.anchor_text,
        severity: row.severity,
        firstSeenReviewId:
          row.first_seen_review_id ?? subjectRevision.review_id,
        replies: replies.get(row.id),
      })),
      guideBuiltAt: subjectRevision.guide_built_at,
    };
    carryItems = classifyCarryItems(
      carryPrevious,
      revision,
      carryPrevious.visiblePaths,
      guidesBefore.guideBuiltAt,
    );
    extras.carryPrompt = buildCarryPromptSection(carryItems, revision);
  }
  const costTally = emptyTally();
  // The engine's answer carries the last review call's tokens only. A JSON
  // retry and a large diff summary are calls of this review too.
  const tokens = { in: 0, out: 0 };
  let response: Awaited<ReturnType<typeof runReviewEngine>>;
  let extensions: ExtensionReport;
  try {
    ({ review: response, extensions } = await withExtensions(
      appPrContext({
        jobId: job.id,
        repo: job.repo,
        prNumber: job.pr_number,
        headSha,
        baseSha: reviewBase,
        branch: String((pr.head as Json | undefined)?.ref ?? "") || null,
        scope,
        sinceCommit:
          scope === "incremental" ? (args.sinceCommit ?? null) : null,
        trigger: args.trigger ?? "manual",
        round: args.round ?? 1,
        files,
        subjectId: subject.id,
        reviewId,
        signal,
        log: (message) => log("info", message),
      }),
      () =>
        runReviewEngine(
          github,
          options,
          async (call) => {
            addResponseCost(costTally, call);
            tokens.in += call.tokensIn;
            tokens.out += call.tokensOut;
          },
          snapshot,
          ai ?? aiFor(options),
          (message) => log("info", message),
          extras,
        ),
      (result) => reviewResultJson(result.text, options.reviewBlocking),
    ));
  } catch (error) {
    // A provider throw or an empty/unusable answer is a failed attempt, not a
    // review that found nothing. Its cost is kept when the provider reported
    // one, and the pull request gets one note pointing at the dashboard.
    await recordFailedReview(github, job, reviewId, costTally, log);
    throw error;
  }
  guideBuiltAt = response.guideBuiltAt;
  const visiblePaths = new Set(response.visiblePaths);
  if (carryPrevious) {
    carryItems = classifyCarryItems(
      carryPrevious,
      revision,
      visiblePaths,
      guideBuiltAt,
    );
  }
  const parsed = parseFindings(response.text);
  log("info", `parsed ${parsed.length} new finding(s) from the AI response`);
  let totalFindings = parsed.length;
  let openCount = 0;
  let closedCount = 0;
  if (carryPrevious) {
    const postedById = new Map(
      listCarryableFindingsForReview(subjectRevision!.review_id).map((row) => [
        row.id,
        row.posted_comment_id,
      ]),
    );
    const verdicts = parsePreviousVerdicts(response.text);
    const resolved = resolveCarryOutcomes(
      carryItems,
      revision,
      visiblePaths,
      verdicts,
      parsed,
    );
    totalFindings = resolved.length;
    for (const row of resolved) {
      if (row.state === "open") openCount++;
      if (row.state === "closed") closedCount++;
      const patch =
        revision.files.find((file) => file.path === row.path)?.patch ?? "";
      insertFinding({
        id: row.id,
        reviewId,
        severity: row.severity,
        path: row.path ?? undefined,
        lineFrom: row.lineFrom ?? undefined,
        lineTo: row.lineTo ?? undefined,
        title: row.title,
        bodyMd: redact(row.bodyMd),
        anchorText:
          row.anchorText ??
          (row.path && row.lineFrom
            ? anchorTextFromPatch(
                patch,
                row.lineFrom,
                row.lineTo ?? row.lineFrom,
              )
            : null),
        state: row.state,
        carriedFromFindingId: row.carriedFromId,
        closeReason: row.closeReason ?? undefined,
        firstSeenReviewId: row.firstSeenReviewId ?? undefined,
        threadCommentId:
          row.state === "open" && row.carriedFromId
            ? (postedById.get(row.carriedFromId) ?? undefined)
            : undefined,
      });
    }
  } else {
    const previous = listFindingsForPr(job.repo, job.pr_number).filter(
      (row) => row.review_id !== reviewId,
    );
    for (const finding of parsed) {
      const repeat = matchRepeat(finding, previous);
      // The next round finds the line again by this text, as the carry-over
      // branch above stores it for its own new findings.
      const patch =
        revision.files.find((file) => file.path === finding.path)?.patch ?? "";
      insertFinding({
        id: crypto.randomUUID(),
        reviewId,
        severity: finding.severity ?? severityOf(finding.heading),
        path: finding.path,
        lineFrom: finding.from,
        lineTo: finding.to,
        title: finding.heading || finding.path,
        bodyMd: redact(finding.excerpt),
        anchorText: anchorTextFromPatch(patch, finding.from, finding.to),
        state: "new",
        firstSeenReviewId: repeat
          ? (repeat.first_seen_review_id ?? repeat.review_id)
          : undefined,
        threadCommentId: repeat?.posted_comment_id ?? undefined,
      });
    }
  }
  addExtensionCost(costTally, extensions);
  setReviewStatus(reviewId, "drafting", {
    findings_count: totalFindings,
    open_count: openCount,
    closed_count: closedCount,
    tokens_in: tokens.in,
    tokens_out: tokens.out,
    ...costColumns(settle(costTally)),
  });
  saveSubjectRevision({
    subjectId: subject.id,
    reviewId,
    files: revision.files,
    // A file skipped as unchanged this round stays judged for the next one.
    visiblePaths: [
      ...visiblePathsToSave(
        carryPrevious?.visiblePaths,
        extras.unchangedPaths,
        visiblePaths,
      ),
    ],
    guideBuiltAt,
  });
  log("info", `publishing ${totalFindings} finding(s) to GitHub`);
  await publish(
    github,
    job,
    reviewId,
    headSha,
    publishFiles,
    log,
    {
      jobId: job.id,
      model: options.highModel ?? "unknown",
      durationMs: Date.now() - startedAt,
      coverage: response.coverage,
      catchesUp,
    },
    options.reviewBlocking,
    extensions,
  );
  await resolveFailureNote(github, job, reviewId, log);
  const openFindings =
    totalFindings - closedCount + standingExtensionFindings(extensions);
  await finishCheck(
    github,
    job,
    checkRunId,
    openFindings === 0 ? "success" : "neutral",
    openFindings === 0 ? "Review completed" : "Review findings",
    listFindingsForReview(reviewId),
    log,
  );
}

export function registerReviewJobHandler(): void {
  registerHandler("review", {
    run(job, log, signal) {
      return runReviewJob(job, log, undefined, undefined, signal);
    },
    reconcile(job, log) {
      return resolveInstallationId(job.repo).then((installationId) => {
        if (installationId === undefined) {
          throw new Error(`no GitHub App installation stored for ${job.repo}`);
        }
        return reconcileReview(job, log, clientFor(installationId));
      });
    },
  });
}

/** `model` pins the review to one model, the way "Retry with the same
 * model" asks; without it the job resolves the model from config when it
 * runs. */
export function enqueueManualReview(
  repo: string,
  prNumber: number,
  pin: { model?: string } = {},
): { id: string; debounced: boolean } {
  return enqueue({
    type: "review",
    repo,
    prNumber,
    args: {
      trigger: "manual",
      ...(pin.model ? { model: pin.model } : {}),
    },
  });
}

/** The round, scope and base of the next review after `last`. A job queued
 * without them works them out when it starts. */
export function roundArgs(
  repo: string,
  last: { head_sha: string | null; round: number } | undefined,
): { scope: string; sinceCommit?: string; round: number } {
  const incremental =
    getRepo(repo)?.review_scope === "incremental" && Boolean(last?.head_sha);
  return {
    scope: incremental ? "incremental" : "whole-pr",
    sinceCommit: incremental ? last!.head_sha! : undefined,
    round: last ? last.round + 1 : 1,
  };
}
