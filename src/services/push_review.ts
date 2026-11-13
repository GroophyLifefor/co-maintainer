/** Commit watch: review a push to the default branch.
 *
 * A push reaches the server two ways, and either may be the only one: the
 * GitHub App's `push` webhook (when the owner turned that event on) or a CI
 * step running `review --remote --range`. Both land in `queuePush`, which
 * keys the push by its `after` sha, so when both report it there is one
 * review and the CI step waits on it.
 *
 * The review runs on the server and does not depend on the CI step staying
 * connected: a step that times out leaves the review running.
 *
 * Issues need the App. Without it a push review still runs and reports to
 * CI, but opens, comments on and closes nothing. */
import { parseFindings, type ParsedFinding } from "../pr/findings.ts";
import { githubFileToRevisionFile } from "../pr/github_revision.ts";
import { reviewWorkspaceRevision } from "../pr/reviewer.ts";
import {
  anchorTextFromPatch,
  parsePreviousVerdicts,
  type PreviousVerdict,
  type ResolvedFinding,
} from "../review/carry_over.ts";
import { normalizeAnchor, type Revision } from "../review/revision.ts";
import { revisionFromSubmitJson } from "../remote/revision_from_submit.ts";
import {
  reviewCoverageFields,
  sortResolvedFindings,
  summaryCounts,
  toJsonFinding,
} from "../cli/review_result.ts";
import { reviewBlockingFrom } from "../review/blocking.ts";
import { withLogSink } from "../util/log.ts";
import { redact } from "../util/redact.ts";
import { readConfig, resolveAppPrivateKey } from "../config.ts";
import {
  addResponseCost,
  costColumns,
  costUsage,
  emptyTally,
  settle,
} from "../util/cost.ts";
import { getRepo } from "../store/repos.ts";
import { getJob, insertJob, listJobs, setJobStatus } from "../store/jobs.ts";
import { insertFinding, listFindingsForReview } from "../store/findings.ts";
import {
  getReview,
  getReviewByJobId,
  setReviewStatus,
} from "../store/reviews.ts";
import {
  addPushSource,
  deletePushInput,
  getOrCreatePushSubject,
  getPushEvent,
  getPushInput,
  insertPushEvent,
  insertPushReview,
  insertWatchIssue,
  listWatchIssues,
  movePushEvents,
  pushSources,
  savePushInput,
  savePushResult,
  setPushEventReview,
  updateWatchIssue,
  type PushSource,
  type WatchIssueRow,
} from "../store/watch.ts";
import { getAppDb } from "../store/app_db.ts";
import { cancel, registerHandler, type LogFn } from "./jobs.ts";
import { recordAiCost } from "./setup.ts";
import {
  aiFor,
  clientFor,
  humanCopy,
  resolveInstallationId,
  reviewOptions,
} from "./review.ts";
import {
  changedLines,
  closeIssue,
  closedStillFoundComment,
  commentOnIssue,
  excerpt,
  fileAt,
  findingSummary,
  fixedComment,
  ISSUE_SEVERITIES,
  issueBody,
  issueTitle,
  lastCommitFor,
  locateAnchor,
  openIssue,
  pushRange,
  readIssueState,
  samePath,
  stillFoundComment,
} from "./watch_issues.ts";
import type { GitHubClient, Json } from "../types.ts";
import type { JobRow } from "../store/rows.ts";

export const PUSH_JOB = "push_review";
export const PUSH_CHECK_JOB = "push_check";
export const CHECK_NAME = "co-maintainer commit watch";

const SHA = /^[0-9a-f]{40}$/;
const ZERO = /^0{40}$/;

export function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}

export function isZeroSha(value: string): boolean {
  return ZERO.test(value);
}

export type PushRequest = {
  repo: string;
  before: string;
  after: string;
  /** `refs/heads/<branch>`. */
  ref: string;
  source: PushSource;
  /** The diff a CI step built. The App path builds its own from GitHub. */
  revision?: Revision;
  deliveryId?: string;
};

export type PushOutcome =
  | { kind: "enqueued" | "attached"; jobId: string; reviewId: string }
  | { kind: "no_changes" }
  | { kind: "skipped"; reason: string; message: string; checkRun: boolean }
  /** cancel-and-merge folded this push into a waiting one, and only the
   * client has the diff: it must send `before..after` instead. */
  | { kind: "extend"; before: string };

export const NOT_INITIALIZED = "This repository is not initialized.";

function branchOf(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function appConfigured(): boolean {
  const config = readConfig();
  return Boolean(config.githubAppId && resolveAppPrivateKey(config));
}

/** The App client for a repository, or undefined when no App covers it. */
async function appClientFor(repo: string): Promise<GitHubClient | undefined> {
  if (!appConfigured()) return undefined;
  try {
    const id = await resolveInstallationId(repo);
    return id === undefined ? undefined : clientFor(id);
  } catch {
    return undefined;
  }
}

/** True when the repository row says an App installation covers it. Cheap
 * and synchronous, for the decisions `queuePush` makes before any call. */
function appCovers(repo: string): boolean {
  return appConfigured() && Boolean(getRepo(repo)?.installation_id);
}

function activePushJobs(repo: string): JobRow[] {
  return [
    ...listJobs({ status: "running", repo }),
    ...listJobs({ status: "queued", repo }),
  ].filter((job) => job.type === PUSH_JOB);
}

function enqueueSkippedCheck(repo: string, after: string): void {
  insertJob({
    id: crypto.randomUUID(),
    type: PUSH_CHECK_JOB,
    repo,
    args: { after, title: NOT_INITIALIZED },
  });
}

/** Records a push and decides what happens to it. Synchronous, so the
 * webhook and the remote submit route can call it as they are. */
export function queuePush(req: PushRequest): PushOutcome {
  const row = getRepo(req.repo);
  if (!row || row.active !== 1) {
    return {
      kind: "skipped",
      reason: "repo-not-active",
      message: "This repository is not active on the server.",
      checkRun: false,
    };
  }
  if (isZeroSha(req.before)) return { kind: "no_changes" };

  const existing = getPushEvent(req.repo, req.after);
  if (existing?.job_id) {
    addPushSource(req.repo, req.after, req.source);
    const review = existing.review_id
      ? getReview(existing.review_id)
      : undefined;
    if (req.source === "ci" && review) {
      return { kind: "attached", jobId: existing.job_id, reviewId: review.id };
    }
    // The App joins a review CI started. A queued or running review reads
    // the sources again when it ends. One that already ended gets its check
    // from a job of its own.
    const sources = pushSources(existing);
    if (
      req.source === "app" &&
      review?.status === "done" &&
      !review.check_run_id &&
      !sources.includes("app")
    ) {
      insertJob({
        id: crypto.randomUUID(),
        type: PUSH_CHECK_JOB,
        repo: req.repo,
        args: { after: req.after, reviewId: review.id },
      });
    }
    return {
      kind: "skipped",
      reason: "already-reviewed",
      message: "This push is already reviewed.",
      checkRun: false,
    };
  }

  if (!row.knowledge_built_at) {
    if (!existing) {
      insertPushEvent({
        repo: req.repo,
        afterSha: req.after,
        beforeSha: req.before,
        ref: req.ref,
        source: req.source,
      });
    }
    const covered = appCovers(req.repo);
    if (covered && !existing) enqueueSkippedCheck(req.repo, req.after);
    return {
      kind: "skipped",
      reason: "not-initialized",
      message: NOT_INITIALIZED,
      checkRun: covered,
    };
  }

  let before = req.before;
  const merged =
    row.watch_push_mode === "cancel-and-merge"
      ? activePushJobs(req.repo).sort((a, b) =>
          a.created_at.localeCompare(b.created_at),
        )
      : [];
  if (merged.length > 0) {
    // The merged review starts where the oldest folded one started.
    const oldest = JSON.parse(merged[0]!.args) as { before?: string };
    if (oldest.before) before = oldest.before;
    if (req.revision && before !== req.before && !appCovers(req.repo)) {
      return { kind: "extend", before };
    }
  }

  const branch = branchOf(req.ref);
  const subject = getOrCreatePushSubject(req.repo, branch);
  const jobId = crypto.randomUUID();
  const reviewId = crypto.randomUUID();
  const db = getAppDb();
  db.exec("BEGIN");
  try {
    if (!existing) {
      insertPushEvent({
        repo: req.repo,
        afterSha: req.after,
        beforeSha: req.before,
        ref: req.ref,
        source: req.source,
      });
    } else {
      addPushSource(req.repo, req.after, req.source);
    }
    insertPushReview({
      id: reviewId,
      subjectId: subject.id,
      repo: req.repo,
      branch,
      jobId,
      beforeSha: before,
      afterSha: req.after,
      model: readConfig().highModel ?? "unknown",
    });
    insertJob({
      id: jobId,
      type: PUSH_JOB,
      repo: req.repo,
      deliveryId: req.deliveryId,
      queueKey: `push:${req.repo}:${req.after}`,
      args: { reviewId, before, after: req.after, branch },
    });
    setPushEventReview(req.repo, req.after, reviewId, jobId);
    // A client diff only covers its own range, so after a merge the server
    // builds the merged diff from GitHub instead.
    const clientDiffFits = !req.revision ? false : before === req.before;
    if (req.revision && clientDiffFits) {
      savePushInput(jobId, JSON.stringify(req.revision));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  for (const job of merged) {
    const old = getReviewByJobId(job.id);
    if (old) movePushEvents(old.id, reviewId, jobId);
    if (job.status === "queued") {
      setJobStatus(job.id, "canceled", {
        superseded_by: jobId,
        cancel_reason: "merged",
      });
      if (old) setReviewStatus(old.id, "canceled");
      deletePushInput(job.id);
    } else {
      cancel(job.id, "merged");
    }
  }
  return { kind: "enqueued", jobId, reviewId };
}

/** The diff of `before..after`, from the CI step when it sent one, otherwise
 * from GitHub's compare API. */
async function pushRevision(
  job: JobRow,
  client: GitHubClient | undefined,
  before: string,
  after: string,
  branch: string,
): Promise<Revision> {
  const input = getPushInput(job.id);
  if (input) {
    const revision = revisionFromSubmitJson(JSON.parse(input));
    return { ...revision, baseLabel: revision.baseLabel || branch };
  }
  if (!client) {
    throw new Error(
      "this push has no diff: the CI step did not send one and no GitHub App covers the repository",
    );
  }
  const compare = await client.request<Json>(
    `repos/${job.repo}/compare/${before}...${after}`,
  );
  const files = Array.isArray(compare.files) ? (compare.files as Json[]) : [];
  return {
    files: files.map((file) => githubFileToRevisionFile(file)),
    title: "",
    description: "",
    baseLabel: branch,
    producer: "github",
  };
}

/** One tracked issue the review is asked about. */
type KnownCheck = {
  issue: WatchIssueRow;
  promptId: string;
  /** Where the code is now, when it could be found. */
  at: { from: number; to: number } | undefined;
  /** The push changed the finding's lines, the condition for a
   * "change in" comment and for closing. */
  touched: boolean;
  /** A maintainer closed it and this is the one check after the closing. */
  closedOnce: boolean;
  /** The file at `after`, undefined when it is gone. */
  content: string | undefined;
};

/** Brings each tracked issue in line with GitHub (a maintainer may have
 * closed or reopened it), then picks the ones this push review must judge:
 * open issues whose lines the push changed, and each issue a maintainer
 * closed that has not been checked once since. */
async function knownChecks(
  client: GitHubClient,
  repo: string,
  revision: Revision,
  after: string,
  log: LogFn,
): Promise<KnownCheck[]> {
  const checks: KnownCheck[] = [];
  const byPath = new Map(revision.files.map((file) => [file.path, file]));
  for (const issue of listWatchIssues(repo)) {
    // A renamed file takes its issue along, whatever the issue's state, so an
    // ignored or closed finding is still recognized under the new name. That
    // is following the code, not a verdict on it.
    const renamed = revision.files.find(
      (f) => f.status === "renamed" && samePath(f.previousPath, issue.path),
    );
    if (renamed) {
      updateWatchIssue(issue.id, { path: renamed.path });
      issue.path = renamed.path;
    }
    if (issue.state === "ignored") continue;
    if (issue.state === "open" || issue.state === "closed_by_user") {
      const state = await readIssueState(client, repo, issue.issue_number);
      if (state && issue.state === "open" && !state.open) {
        updateWatchIssue(issue.id, {
          state: state.closedByBot ? "closed_by_us" : "closed_by_user",
          closed_check: state.closedByBot ? null : "pending",
        });
        issue.state = state.closedByBot ? "closed_by_us" : "closed_by_user";
        issue.closed_check = state.closedByBot ? null : "pending";
        log("info", `issue #${issue.issue_number} was closed on GitHub`);
      } else if (state && issue.state === "closed_by_user" && state.open) {
        updateWatchIssue(issue.id, { state: "open", closed_check: null });
        issue.state = "open";
        issue.closed_check = null;
        log("info", `issue #${issue.issue_number} was reopened on GitHub`);
      }
    }
    const closedOnce =
      issue.state === "closed_by_user" && issue.closed_check === "pending";
    if (issue.state !== "open" && !closedOnce) continue;
    if (!issue.path) continue;
    const file = byPath.get(issue.path);
    if (!file && !closedOnce) continue;
    const content = await fileAt(client, repo, issue.path, after);
    const at =
      content === undefined
        ? undefined
        : locateAnchor(content, issue.anchor_text, issue.line_from ?? 1);
    let touched = false;
    if (file) {
      if (file.status === "removed" || !at) touched = true;
      else {
        const lines = changedLines(file.patch);
        for (let n = at.from; n <= at.to; n++) if (lines.has(n)) touched = true;
      }
    }
    if (at && !touched) {
      updateWatchIssue(issue.id, { line_from: at.from, line_to: at.to });
    }
    if (!touched && !closedOnce) continue;
    checks.push({
      issue,
      promptId: `F${checks.length + 1}`,
      at,
      touched,
      closedOnce,
      content,
    });
  }
  return checks;
}

function knownPrompt(checks: KnownCheck[]): string {
  if (checks.length === 0) return "";
  const entries = checks.map((check) => {
    const { content, issue } = check;
    const where = check.at
      ? `${issue.path}:${check.at.from}-${check.at.to}`
      : `${issue.path} (the recorded code is no longer where it was)`;
    // A deleted file is not by itself a fix: the code may have moved. The
    // model decides, from the DIFF.
    const code =
      content === undefined
        ? "This file no longer exists at this commit. If this code moved to another place in the DIFF, answer open with that path:from-to. If it is gone, answer closed."
        : check.at
          ? excerpt(content, check.at.from, check.at.to)
          : excerpt(
              content,
              issue.line_from ?? 1,
              issue.line_to ?? issue.line_from ?? 1,
            );
    return [
      `${check.promptId} · known issue #${issue.issue_number} · ${where}`,
      issue.title,
      issue.body_md.slice(0, 600),
      "CURRENT CODE:",
      code,
    ].join("\n");
  });
  return [
    "KNOWN ISSUES (problems this repository already has an open issue for):",
    "These were found by earlier reviews. Review the DIFF from scratch as",
    "usual, and in addition decide for each entry below whether the problem",
    "is still in the CURRENT CODE shown. Answer every id in previousFindings,",
    'state "open" when the problem is still there and "closed" only when the',
    "code now clearly fixes it. When the code moved, give its new place as",
    "open path:from-to. Do not report these again under findings. The same",
    "kind of problem in other code, in this file or another one, is a new",
    "finding: report it under findings as usual.",
    "",
    entries.join("\n\n"),
    "",
  ].join("\n");
}

function sameFinding(issue: WatchIssueRow, finding: ResolvedFinding): boolean {
  if (!samePath(issue.path, finding.path)) return false;
  if (issue.anchor_text && finding.anchorText) {
    return (
      normalizeAnchor(issue.anchor_text) === normalizeAnchor(finding.anchorText)
    );
  }
  const from = issue.line_from ?? 0;
  const to = issue.line_to ?? from;
  return (
    (finding.lineFrom ?? 0) <= to &&
    from <= (finding.lineTo ?? finding.lineFrom ?? 0)
  );
}

function resolvedNew(
  parsed: ParsedFinding[],
  revision: Revision,
): ResolvedFinding[] {
  const byPath = new Map(revision.files.map((file) => [file.path, file]));
  return parsed.map((finding) => {
    const file = finding.path ? byPath.get(finding.path) : undefined;
    return {
      id: crypto.randomUUID(),
      state: "new" as const,
      path: finding.path,
      lineFrom: finding.from,
      lineTo: finding.to,
      title: finding.heading || finding.path,
      bodyMd: finding.excerpt,
      anchorText:
        file && finding.from
          ? anchorTextFromPatch(
              file.patch,
              finding.from,
              finding.to ?? finding.from,
            )
          : null,
      severity: finding.severity ?? "P2",
      carriedFromId: null,
      firstSeenReviewId: null,
    };
  });
}

function annotationLevel(severity: string): "failure" | "warning" | "notice" {
  if (severity === "P0" || severity === "P1") return "failure";
  return severity === "P2" ? "warning" : "notice";
}

async function startCheckRun(
  client: GitHubClient,
  repo: string,
  after: string,
  reviewId: string,
  log: LogFn,
): Promise<string | undefined> {
  if (!client.createCheckRun) return undefined;
  try {
    const check = await client.createCheckRun<Json>(
      `repos/${repo}/check-runs`,
      {
        name: CHECK_NAME,
        head_sha: after,
        status: "in_progress",
        started_at: new Date().toISOString(),
        external_id: reviewId,
      },
    );
    const id = String(check.id ?? "");
    if (id) setReviewStatus(reviewId, "running", { check_run_id: id });
    return id || undefined;
  } catch (error) {
    log("info", `GitHub Check Run unavailable: ${redact(String(error))}`);
    return undefined;
  }
}

type CheckFinding = Pick<
  ResolvedFinding,
  "path" | "lineFrom" | "lineTo" | "severity" | "title" | "bodyMd"
>;

/** Completes the App's check run: the one this review started, or a new one
 * already completed when the App's delivery arrived after the review began.
 * Every end goes through here, canceled and failed included, so no check is
 * left in progress. */
async function completeCheckRun(
  client: GitHubClient,
  repo: string,
  input: {
    after: string;
    reviewId: string;
    checkRunId: string | undefined;
    title: string;
    summary: string;
    findings: CheckFinding[];
  },
  log: LogFn,
): Promise<void> {
  const body = {
    status: "completed",
    // Commit watch reports, it never blocks: the push is already in.
    conclusion: "success",
    completed_at: new Date().toISOString(),
    output: {
      title: humanCopy(input.title),
      summary: humanCopy(input.summary),
      annotations: input.findings
        .filter((finding) => finding.path)
        .slice(0, 50)
        .map((finding) => {
          const start = Math.max(1, finding.lineFrom ?? 1);
          return {
            path: finding.path,
            start_line: start,
            end_line: Math.max(start, finding.lineTo ?? start),
            annotation_level: annotationLevel(finding.severity),
            title: humanCopy(`${finding.severity}: ${finding.title}`),
            message: humanCopy(finding.bodyMd),
          };
        }),
    },
  };
  try {
    if (input.checkRunId) {
      if (!client.updateCheckRun) return;
      await client.updateCheckRun<Json>(
        `repos/${repo}/check-runs/${input.checkRunId}`,
        body,
      );
      return;
    }
    if (!client.createCheckRun) return;
    const check = await client.createCheckRun<Json>(
      `repos/${repo}/check-runs`,
      {
        ...body,
        name: CHECK_NAME,
        head_sha: input.after,
        external_id: input.reviewId,
      },
    );
    const id = String(check.id ?? "");
    if (id) {
      setReviewStatus(
        input.reviewId,
        getReview(input.reviewId)?.status ?? "done",
        { check_run_id: id },
      );
    }
  } catch (error) {
    log("info", `GitHub Check Run update failed: ${redact(String(error))}`);
  }
}

/** Where a tracked finding is now, and its code, so the next push finds it.
 * The model's "open path:from-to" wins, since the push may have rewritten
 * the very lines the old code fragment matched. */
function trackedLocation(
  check: KnownCheck,
  answer: PreviousVerdict | undefined,
  revision: Revision,
): Partial<
  Pick<WatchIssueRow, "path" | "line_from" | "line_to" | "anchor_text">
> {
  if (answer?.state === "open" && answer.from) {
    const to = Math.max(answer.from, answer.to ?? answer.from);
    if (!answer.path || samePath(answer.path, check.issue.path)) {
      const lines = check.content?.split("\n");
      const anchor = lines?.slice(answer.from - 1, to).join("\n");
      if (anchor?.trim()) {
        return { line_from: answer.from, line_to: to, anchor_text: anchor };
      }
    } else {
      // The code moved to another file, which the model can only point at
      // inside the DIFF, so its code comes from that file's patch.
      const moved = revision.files.find((f) => samePath(f.path, answer.path!));
      const anchor = moved
        ? anchorTextFromPatch(moved.patch, answer.from, to)
        : null;
      if (moved && anchor?.trim()) {
        return {
          path: moved.path,
          line_from: answer.from,
          line_to: to,
          anchor_text: anchor,
        };
      }
    }
  }
  return check.at ? { line_from: check.at.from, line_to: check.at.to } : {};
}

export type IssueActivity = {
  opened: number[];
  stillFound: number[];
  closed: number[];
  closeDenied: number[];
  closedStillFound: number[];
};

/** Applies the review's verdicts to the tracked issues and opens an issue
 * for each new P0/P1 finding. Returns the findings left to report, without
 * the ones a maintainer said to ignore. */
async function applyIssues(input: {
  client: GitHubClient;
  repo: string;
  branch: string;
  before: string;
  after: string;
  reviewId: string;
  checks: KnownCheck[];
  verdicts: Map<string, PreviousVerdict>;
  found: ResolvedFinding[];
  revision: Revision;
  openIssues: boolean;
  log: LogFn;
}): Promise<{ report: ResolvedFinding[]; activity: IssueActivity }> {
  const { client, repo, log } = input;
  const range = pushRange(input.before, input.after);
  const activity: IssueActivity = {
    opened: [],
    stillFound: [],
    closed: [],
    closeDenied: [],
    closedStillFound: [],
  };
  const now = new Date().toISOString();
  for (const check of input.checks) {
    const issue = check.issue;
    // No answer counts as still there: closing needs an explicit "fixed".
    const answer = input.verdicts.get(check.promptId);
    const verdict = answer?.state ?? "open";
    const location = trackedLocation(check, answer, input.revision);
    if (check.closedOnce) {
      if (verdict === "open") {
        await commentOnIssue(
          client,
          repo,
          issue.issue_number,
          closedStillFoundComment(range),
        );
        activity.closedStillFound.push(issue.issue_number);
      }
      updateWatchIssue(issue.id, {
        ...location,
        closed_check: verdict === "open" ? "still_found" : "fixed",
        last_review_id: input.reviewId,
        last_check:
          verdict === "open" ? `still found by ${range}` : `fixed in ${range}`,
        last_check_at: now,
      });
      continue;
    }
    // A deleted file has no last commit at `after`. Then the push itself is
    // the commit that moved or deleted it.
    const where = location.path ?? issue.path;
    const commit =
      (where && (await lastCommitFor(client, repo, where, input.after))) ||
      input.after;
    if (verdict === "closed") {
      await commentOnIssue(
        client,
        repo,
        issue.issue_number,
        fixedComment(commit, range),
      );
      const closed = await closeIssue(client, repo, issue.issue_number);
      (closed ? activity.closed : activity.closeDenied).push(
        issue.issue_number,
      );
      // An issue it could not close is still open on GitHub, so it stays open
      // here too: counted on the dashboard, and no duplicate is opened.
      updateWatchIssue(issue.id, {
        ...location,
        state: closed ? "closed_by_us" : "open",
        last_review_id: input.reviewId,
        last_check: `fixed in ${range}`,
        last_check_at: now,
      });
    } else {
      await commentOnIssue(
        client,
        repo,
        issue.issue_number,
        stillFoundComment(commit, input.after, range),
      );
      activity.stillFound.push(issue.issue_number);
      updateWatchIssue(issue.id, {
        ...location,
        last_review_id: input.reviewId,
        last_check: `still found by ${range}`,
        last_check_at: now,
      });
    }
  }

  const tracked = listWatchIssues(repo);
  const report: ResolvedFinding[] = [];
  for (const finding of input.found) {
    // One problem can have had several issues over time (fixed, back again).
    // An ignore on any of them holds for good.
    const matches = tracked.filter((issue) => sameFinding(issue, finding));
    if (matches.some((issue) => issue.state === "ignored")) continue;
    report.push(finding);
    if (!input.openIssues || !ISSUE_SEVERITIES.has(finding.severity)) continue;
    // The same problem already has an issue. A maintainer closed it and it is
    // still there: it stays closed, once per closing. Fixed and back again:
    // a new issue.
    if (
      matches.some(
        (issue) =>
          issue.state === "open" ||
          (issue.state === "closed_by_user" && issue.closed_check !== "fixed"),
      )
    ) {
      continue;
    }
    const summary = findingSummary(finding.title, finding.bodyMd);
    const number = await openIssue(client, repo, {
      title: issueTitle(finding.severity, summary),
      severity: finding.severity,
      body: issueBody({
        id: finding.id,
        body: finding.bodyMd,
        repo,
        after: input.after,
        before: input.before,
        branch: input.branch,
        path: finding.path,
        lineFrom: finding.lineFrom,
        lineTo: finding.lineTo,
      }),
    });
    insertWatchIssue({
      repo,
      issueNumber: number,
      severity: finding.severity,
      title: summary,
      bodyMd: finding.bodyMd,
      path: finding.path,
      lineFrom: finding.lineFrom,
      lineTo: finding.lineTo,
      anchorText: finding.anchorText,
      reviewId: input.reviewId,
    });
    activity.opened.push(number);
    log("info", `opened issue #${number} for a ${finding.severity} finding`);
  }
  return { report, activity };
}

/** Ignored findings are dropped even with no App: the hard filter is in
 * SQLite and needs no GitHub call. */
function withoutIgnored(
  repo: string,
  found: ResolvedFinding[],
): ResolvedFinding[] {
  const ignored = listWatchIssues(repo).filter(
    (issue) => issue.state === "ignored",
  );
  return found.filter(
    (finding) => !ignored.some((issue) => sameFinding(issue, finding)),
  );
}

async function runPushReview(
  job: JobRow,
  log: LogFn,
  signal: AbortSignal,
): Promise<void> {
  const args = JSON.parse(job.args) as {
    reviewId: string;
    before: string;
    after: string;
    branch: string;
  };
  const review = getReview(args.reviewId);
  if (!review) throw new Error("push review row missing");
  const range = pushRange(args.before, args.after);
  const event = getPushEvent(job.repo, args.after);
  const sources = event ? pushSources(event) : [];
  setReviewStatus(review.id, "running");
  log("info", `push review started for ${job.repo} ${range} on ${args.branch}`);

  let completed = false;
  let client: GitHubClient | undefined;
  let checkRunId: string | undefined;
  try {
    client = await appClientFor(job.repo);
    checkRunId =
      client && sources.includes("app")
        ? await startCheckRun(client, job.repo, args.after, review.id, log)
        : undefined;
    const revision = await pushRevision(
      job,
      client,
      args.before,
      args.after,
      args.branch,
    );

    const checks = client
      ? await knownChecks(client, job.repo, revision, args.after, log)
      : [];
    const options = reviewOptions(job.repo, 0, (text) => log("info", text));
    const ai = aiFor(options);
    const costTally = emptyTally();
    let tokensIn = 0;
    let tokensOut = 0;
    const started = performance.now();
    const response =
      revision.files.length === 0 && checks.length === 0
        ? undefined
        : await withLogSink(
            (phase, message) => log("info", `[${phase}] ${message}`),
            () =>
              reviewWorkspaceRevision(
                revision,
                options,
                args.after,
                async (call) => {
                  tokensIn += call.tokensIn;
                  tokensOut += call.tokensOut;
                  addResponseCost(costTally, call);
                  await recordAiCost(job.repo, "review_push", call);
                },
                ai,
                (message) => log("info", message),
                { carryPrompt: knownPrompt(checks), job: "review_push" },
              ),
          );
    if (signal.aborted) return;

    const text = response?.text ?? "";
    const verdicts = new Map(
      parsePreviousVerdicts(text).map((v) => [v.id, v] as const),
    );
    const found = sortResolvedFindings(
      resolvedNew(parseFindings(text), revision),
    );
    const row = getRepo(job.repo);
    const { report, activity } = client
      ? await applyIssues({
          client,
          repo: job.repo,
          branch: args.branch,
          before: args.before,
          after: args.after,
          reviewId: review.id,
          checks,
          verdicts,
          found,
          revision,
          openIssues: row?.watch_open_issues !== 0,
          log,
        })
      : {
          report: withoutIgnored(job.repo, found),
          activity: {
            opened: [],
            stillFound: [],
            closed: [],
            closeDenied: [],
            closedStillFound: [],
          },
        };

    for (const finding of report) {
      insertFinding({
        id: finding.id,
        reviewId: review.id,
        severity: finding.severity,
        path: finding.path ?? undefined,
        lineFrom: finding.lineFrom ?? undefined,
        lineTo: finding.lineTo ?? undefined,
        title: finding.title,
        bodyMd: finding.bodyMd,
        anchorText: finding.anchorText,
        state: "new",
      });
    }

    const blockingMode = reviewBlockingFrom(options.reviewBlocking);
    const settled = settle(costTally);
    const covered = reviewCoverageFields(
      revision,
      response?.coverage,
      response?.warnings ?? [],
    );
    const result = {
      subject: { repo: job.repo, branch: args.branch, prNumber: null },
      push: { before: args.before, after: args.after, range },
      revision: covered.revision,
      guide: { builtAt: response?.guideBuiltAt ?? null },
      codegraph: { state: response?.codegraphState ?? "disabled" },
      summary: summaryCounts(report, blockingMode),
      findings: report.map((finding) => toJsonFinding(finding, blockingMode)),
      warnings: covered.warnings,
      issues: activity,
      usage: {
        tokensIn,
        tokensOut,
        ...costUsage(costTally),
        billedTo: "server",
      },
      remote: { jobId: job.id, reviewId: review.id },
    };
    savePushResult(review.id, result);
    setReviewStatus(review.id, "done", {
      findings_count: report.length,
      open_count: report.length,
      guide_built_at: response?.guideBuiltAt ?? null,
      duration_ms: Math.round(performance.now() - started),
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      billed_to: "server",
      ...costColumns(settled),
    });
    deletePushInput(job.id);
    completed = true;
    // The App's delivery may have joined this review while it ran (CI came
    // first). Read the sources again now that the review is done: a later
    // delivery sees "done" and queues the check itself.
    const joined = getPushEvent(job.repo, args.after);
    if (
      client &&
      (checkRunId || (joined && pushSources(joined).includes("app")))
    ) {
      await completeCheckRun(
        client,
        job.repo,
        {
          after: args.after,
          reviewId: review.id,
          checkRunId,
          ...resultCheckText(report.length, range),
          findings: report,
        },
        log,
      );
    }
    log("info", `push review finished (${report.length} findings)`);
  } finally {
    if (!completed) {
      setReviewStatus(review.id, signal.aborted ? "canceled" : "failed");
      if (!signal.aborted) deletePushInput(job.id);
      if (client && checkRunId) {
        await completeCheckRun(
          client,
          job.repo,
          {
            after: args.after,
            reviewId: review.id,
            checkRunId,
            ...stoppedCheckText(signal.aborted, range),
            findings: [],
          },
          log,
        );
      }
    }
  }
}

function stoppedCheckText(
  aborted: boolean,
  range: string,
): { title: string; summary: string } {
  return aborted
    ? {
        title: "Review canceled",
        summary: `The review of ${range} was canceled. When a newer push was merged into it, that review covers this push.`,
      }
    : {
        title: "Review did not finish",
        summary: `The review of ${range} did not finish. The dashboard has the reason.`,
      };
}

function resultCheckText(
  count: number,
  range: string,
): { title: string; summary: string } {
  return count === 0
    ? { title: `No findings in ${range}`, summary: "No actionable findings." }
    : {
        title: `${count} finding${count === 1 ? "" : "s"} in ${range}`,
        summary: `${count} finding(s) reported.`,
      };
}

/** The App's check for a review that finished before the App's delivery
 * arrived, built from what the review stored. */
async function publishLateCheck(
  job: JobRow,
  reviewId: string,
  after: string,
  log: LogFn,
): Promise<void> {
  const review = getReview(reviewId);
  if (!review || review.check_run_id) return;
  const client = await appClientFor(job.repo);
  if (!client) return;
  const findings = listFindingsForReview(reviewId).map((row) => ({
    path: row.path,
    lineFrom: row.line_from,
    lineTo: row.line_to,
    severity: row.severity,
    title: row.title,
    bodyMd: row.body_md,
  }));
  await completeCheckRun(
    client,
    job.repo,
    {
      after,
      reviewId,
      checkRunId: undefined,
      ...resultCheckText(
        findings.length,
        pushRange(review.base_sha ?? after, after),
      ),
      findings,
    },
    log,
  );
}

async function runSkippedCheck(job: JobRow, log: LogFn): Promise<void> {
  const args = JSON.parse(job.args) as {
    after: string;
    title?: string;
    reviewId?: string;
  };
  if (args.reviewId) {
    await publishLateCheck(job, args.reviewId, args.after, log);
    return;
  }
  const client = await appClientFor(job.repo);
  if (!client?.createCheckRun) {
    log("info", "no GitHub App covers this repository, no check run");
    return;
  }
  await client.createCheckRun<Json>(`repos/${job.repo}/check-runs`, {
    name: CHECK_NAME,
    head_sha: args.after,
    status: "completed",
    conclusion: "skipped",
    completed_at: new Date().toISOString(),
    output: { title: args.title ?? "", summary: args.title ?? "" },
  });
}

export function registerPushReviewHandlers(): void {
  registerHandler(PUSH_JOB, {
    run: runPushReview,
    // A push review that was running when the server stopped may have opened
    // issues already. Running it again could open them twice, so it ends.
    // The check it started is completed here, since its finally never ran.
    async reconcile(job, log) {
      const review = getReviewByJobId(job.id);
      if (!review) return "canceled";
      setReviewStatus(review.id, "failed");
      if (review.check_run_id) {
        const args = JSON.parse(job.args) as { before: string; after: string };
        const client = await appClientFor(job.repo);
        if (client) {
          await completeCheckRun(
            client,
            job.repo,
            {
              after: args.after,
              reviewId: review.id,
              checkRunId: review.check_run_id,
              ...stoppedCheckText(false, pushRange(args.before, args.after)),
              findings: [],
            },
            log,
          );
        }
      }
      return "canceled";
    },
  });
  registerHandler(PUSH_CHECK_JOB, {
    async run(job, log) {
      await runSkippedCheck(job, log);
    },
  });
}

/** For the sync route: the stored result of a finished push review. */
export function pushJobStatus(jobId: string): JobRow | undefined {
  return getJob(jobId);
}
