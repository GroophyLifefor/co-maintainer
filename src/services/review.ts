/** Review jobs: run the model, persist findings, post to GitHub. */
import denoConfig from "../../deno.json" with { type: "json" };
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
import {
  anchorTextFromPatch,
  buildCarryPromptSection,
  type CarryItem,
  type CarryPrevious,
  classifyCarryItems,
  incrementalDiffPaths,
  parsePreviousVerdicts,
  resolveCarryOutcomes,
} from "../review/carry_over.ts";
import { runReviewEngine } from "../review/engine.ts";
import { loadGuides } from "../review/guides.ts";
import { matchRepeat } from "../pr/rounds.ts";
import type { Snapshot } from "../pr/snapshot.ts";
import { readConfig } from "../config.ts";
import { outsideCode, redact } from "../util/redact.ts";
import { getRepo, setInstallationId } from "../store/repos.ts";
import {
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
import type { AiProvider, GitHubClient, Json, Options } from "../types.ts";
import type { JobRow } from "../store/rows.ts";

const ACCESS_DENIED_BODY =
  "The App does not have access to review this pull request.";

export function humanCopy(text: string): string {
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

export function splitInline(
  findings: ParsedFinding[],
  files: Json[],
): {
  inline: { finding: ParsedFinding; anchor: Anchor; suggestion: boolean }[];
  leftover: ParsedFinding[];
} {
  const patches = new Map(
    files.map((
      file,
    ) => [String(file.filename ?? ""), String(file.patch ?? "")]),
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

export interface ReviewMetadata {
  jobId: string;
  model: string;
  durationMs: number;
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

function metadataBlock({ jobId, model, durationMs }: ReviewMetadata): string {
  return `\n\n<details>\n<summary>Metadata</summary>\n\n` +
    `- Activity: ${jobId}\n` +
    `- co-maintainer version: ${denoConfig.version}\n` +
    `- Model: ${model}\n` +
    `- Duration: ${formatDuration(durationMs)}\n` +
    `</details>`;
}

/** Short summary on the review itself. Findings that map to the diff go
 * inline. Leftovers are listed here as one line each, not as a CLI dump. */
export function reviewBody(
  findings: ParsedFinding[],
  metadata: ReviewMetadata,
  _inlineCount = 0,
): string {
  if (findings.length === 0) {
    return `No actionable findings.${metadataBlock(metadata)}`;
  }
  const lines: string[] = ["Review summary", ""];
  for (const finding of findings) {
    const title = humanCopy(finding.heading || finding.path);
    const summary = humanCopy(
      finding.summary ??
        finding.excerpt.split(/\r?\n/).find((line) => line.trim()) ?? "",
    );
    lines.push(`- ${title}${summary ? `: ${summary}` : ""}`);
  }
  return lines.join("\n") + metadataBlock(metadata);
}

function inlineCommentBody(
  finding: ParsedFinding,
  suggestion = false,
): string {
  const heading = humanCopy(finding.heading);
  const excerpt = humanCopy(
    suggestion
      ? withoutSuggestionLine(finding.excerpt)
      : stripSuggestion(finding.excerpt),
  );
  const marker = `${finding.path}:${finding.from}`;
  const at = excerpt.indexOf(marker);
  const rest = at >= 0
    ? excerpt.slice(at + marker.length).trim()
    : excerpt.trim();
  if (!rest) return heading;
  return `${heading}\n\n${rest}`;
}

export function reviewOptions(repo: string, prNumber: number): Options {
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
    ai: config.ai && config.ai !== "none" ? config.ai : "openrouter",
    aiToken: config.token,
    highModel: config.highModel,
    lowModel: config.lowModel,
    synthesisVersion: 16,
    includeCodebase: true,
    includePullRequests: true,
    includePullRequestChanges: true,
    includeCommitHistory: true,
    includeHowRepoWorks: true,
    useCodegraph: getRepo(repo)?.use_codegraph === 1,
  };
}

export function aiFor(options: Options): AiProvider {
  if (Deno.env.get("CM_FAKE_AI") === "1") return new FakeAiProvider();
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
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error("review jobs need the GitHub App configured");
  }
  return new AppClient(
    config.githubAppId,
    config.githubAppPrivateKey,
    installationId,
  );
}

export async function resolveInstallationId(
  fullName: string,
): Promise<number | undefined> {
  const current = getRepo(fullName)?.installation_id;
  if (current) return current;
  const config = readConfig();
  if (!config.githubAppId || !config.githubAppPrivateKey) return undefined;
  const installationId = await findInstallationForRepo(
    config.githubAppId,
    config.githubAppPrivateKey,
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
    { body: ACCESS_DENIED_BODY },
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
      const startLine = Math.max(
        1,
        finding.line_from ?? finding.line_to ?? 1,
      );
      const endLine = Math.max(startLine, finding.line_to ?? startLine);
      return {
        path: finding.path,
        start_line: startLine,
        end_line: endLine,
        start_column: 1,
        end_column: 1,
        annotation_level: finding.severity === "P1"
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
          findings.length === 0
            ? "No actionable findings."
            : `${findings.length} finding(s) reported.`,
        ),
        annotations: checkAnnotations(findings),
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
): Promise<void> {
  const stored = listFindingsForReview(reviewId);
  const replies = stored.filter((row) => row.thread_comment_id);
  const freshRows = stored.filter((row) =>
    row.state === "new" && !row.thread_comment_id
  );
  const fresh: ParsedFinding[] = freshRows.map((row) => ({
    path: row.path ?? "",
    from: row.line_from ?? 0,
    to: row.line_to ?? row.line_from ?? 0,
    heading: row.title,
    excerpt: row.body_md,
  }));
  const { inline, leftover } = splitInline(fresh, files);
  const anchorByRow = new Map<string, Anchor>();
  for (const { finding, anchor } of inline) {
    const row = freshRows.find((item) =>
      item.path === finding.path &&
      item.line_from === finding.from &&
      item.line_to === finding.to
    );
    if (row) anchorByRow.set(row.id, anchor);
  }
  const freshSummaryKeys = new Set(
    [...leftover, ...inline.map(({ finding }) => finding)].map((finding) =>
      `${finding.path}\0${finding.from}\0${finding.to}`),
  );
  const summaryFindings = [
    ...leftover,
    ...inline.map(({ finding }) => finding),
    ...stored
      .filter((row) => row.state !== "closed")
      .filter((row) => {
        const key =
          `${row.path ?? ""}\0${row.line_from ?? 0}\0${row.line_to ?? row.line_from ?? 0}`;
        return !freshSummaryKeys.has(key);
      })
      .map((row) => ({
        path: row.path ?? "",
        from: row.line_from ?? 0,
        to: row.line_to ?? row.line_from ?? 0,
        heading: row.title,
        excerpt: row.body_md,
      })),
  ];
  const body = reviewBody(
    summaryFindings,
    metadata,
    inline.length + replies.length,
  );
  const comments = inline.map(({ finding, anchor, suggestion }) => ({
    path: finding.path,
    body: inlineCommentBody(finding, suggestion),
    line: anchor.line,
    side: "RIGHT",
    ...(anchor.start_line === undefined
      ? {}
      : { start_line: anchor.start_line, start_side: "RIGHT" }),
  }));
  if (
    hasForbiddenCopy(body) ||
    hasForbiddenCopy(ACCESS_DENIED_BODY) ||
    comments.some((comment) => hasForbiddenCopy(comment.body))
  ) {
    throw new Error("review body contains forbidden copy characters");
  }
  for (const row of replies) {
    const text = inlineCommentBody({
      path: row.path ?? "",
      from: row.line_from ?? 0,
      to: row.line_to ?? row.line_from ?? 0,
      heading: row.title,
      excerpt: row.body_md,
    });
    const posted = await post(
      client,
      `repos/${job.repo}/pulls/${job.pr_number}/comments`,
      { body: text, in_reply_to: Number(row.thread_comment_id) },
    );
    setFindingPosted(
      row.id,
      String(posted.id ?? ""),
      row.thread_comment_id ?? undefined,
    );
  }
  const payload = {
    commit_id: headSha,
    body,
    event: reviewEvent(stored.length),
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
        const anchor = anchorByRow.get(row.id);
        if (row.posted_comment_id || !row.path || !anchor) continue;
        const hit = listed.find((item) =>
          String(item.path ?? "") === row.path &&
          Number(item.line ?? item.original_line ?? 0) === anchor.line
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
        { body: reviewBody(summaryFindings, metadata) },
      );
      setReviewStatus(reviewId, "posted", {
        posted_review_id: String(posted.id ?? ""),
        findings_count: stored.length,
        posted_fallback: 1,
      });
      return;
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
    return String(item.commit_id ?? "") === review.head_sha &&
      String(user?.type ?? "") === "Bot";
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
): Promise<void> {
  try {
    await runReviewJobCore(job, log, client, ai);
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
): Promise<void> {
  const startedAt = Date.now();
  if (job.pr_number === null) {
    throw new Error("review job is missing a pull request number");
  }
  const repo = getRepo(job.repo);
  const installationId = repo?.installation_id ??
    await resolveInstallationId(job.repo);
  if (!client && installationId === undefined) {
    throw new Error(`no GitHub App installation stored for ${job.repo}`);
  }
  const github = client ?? clientFor(installationId!);
  const existing = getReviewByJobId(job.id);
  if (
    existing &&
    (existing.status === "posting" || existing.status === "posted" ||
      existing.status === "access_denied")
  ) {
    await reconcileReview(job, log, github);
    return;
  }

  const options = reviewOptions(job.repo, job.pr_number);
  const args = JSON.parse(job.args || "{}") as {
    trigger?: string;
    scope?: string;
    sinceCommit?: string;
    round?: number;
  };
  const pr = await github.request<Json>(
    `repos/${job.repo}/pulls/${job.pr_number}`,
  );
  const headSha = String((pr.head as Json | undefined)?.sha ?? "");
  const mergeBase = String((pr.base as Json | undefined)?.sha ?? "");
  let scope = args.scope === "incremental" ? "incremental" : "whole-pr";
  if (scope === "incremental" && !args.sinceCommit) {
    scope = "whole-pr";
  }
  let reviewBase = scope === "incremental" && args.sinceCommit
    ? args.sinceCommit
    : mergeBase;
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
  const baseLabel = `origin/${
    String((pr.base as Json | undefined)?.ref ?? "main")
  }`;
  const revision = githubPullRequestToRevision(publishFiles, pr, baseLabel);
  const guidesBefore = await loadGuides(job.repo);
  let guideBuiltAt = guidesBefore.guideBuiltAt;
  const subjectRevision = getSubjectRevision(subject.id);
  let carryItems: CarryItem[] = [];
  let carryPrevious: CarryPrevious | null = null;
  const extras: { carryPrompt?: string; unchangedPaths?: string[] } = {};
  if (subjectRevision) {
    const prevFiles = parseRevisionFiles(subjectRevision);
    const { unchanged } = incrementalDiffPaths(revision, prevFiles);
    extras.unchangedPaths = scope === "incremental" ? unchanged : undefined;
    const storedRows = listCarryableFindingsForReview(
      subjectRevision.review_id,
    );
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
        firstSeenReviewId: row.first_seen_review_id ?? subjectRevision.review_id,
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
  const response = await runReviewEngine(
    github,
    options,
    undefined,
    snapshot,
    ai ?? aiFor(options),
    (message) => log("info", message),
    extras,
  );
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
      guideBuiltAt,
      carryPrevious,
    );
    totalFindings = resolved.length;
    for (const row of resolved) {
      if (row.state === "open") openCount++;
      if (row.state === "closed") closedCount++;
      const patch = revision.files.find((file) =>
        file.path === row.path
      )?.patch ??
        "";
      insertFinding({
        id: row.id,
        reviewId,
        severity: row.severity,
        path: row.path ?? undefined,
        lineFrom: row.lineFrom ?? undefined,
        lineTo: row.lineTo ?? undefined,
        title: row.title,
        bodyMd: redact(row.bodyMd),
        anchorText: row.anchorText ??
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
        threadCommentId: row.state === "open" && row.carriedFromId
          ? postedById.get(row.carriedFromId) ?? undefined
          : undefined,
      });
    }
  } else {
    const previous = listFindingsForPr(job.repo, job.pr_number).filter((row) =>
      row.review_id !== reviewId
    );
    for (const finding of parsed) {
      const repeat = matchRepeat(finding, previous);
      insertFinding({
        id: crypto.randomUUID(),
        reviewId,
        severity: finding.severity ?? severityOf(finding.heading),
        path: finding.path,
        lineFrom: finding.from,
        lineTo: finding.to,
        title: finding.heading || finding.path,
        bodyMd: redact(finding.excerpt),
        state: "new",
        firstSeenReviewId: repeat
          ? (repeat.first_seen_review_id ?? repeat.review_id)
          : undefined,
        threadCommentId: repeat?.posted_comment_id ?? undefined,
      });
    }
  }
  setReviewStatus(reviewId, "drafting", {
    findings_count: totalFindings,
    open_count: openCount,
    closed_count: closedCount,
    tokens_in: response.tokensIn,
    tokens_out: response.tokensOut,
    cost: response.cost,
  });
  saveSubjectRevision({
    subjectId: subject.id,
    reviewId,
    files: revision.files,
    visiblePaths: [...visiblePaths],
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
    },
  );
  await finishCheck(
    github,
    job,
    checkRunId,
    totalFindings === 0 ? "success" : "neutral",
    totalFindings === 0 ? "Review completed" : "Review findings",
    listFindingsForReview(reviewId),
    log,
  );
}

export function registerReviewJobHandler(): void {
  registerHandler("review", {
    run(job, log, _signal) {
      return runReviewJob(job, log);
    },
    reconcile(job, log) {
      return resolveInstallationId(job.repo).then((installationId) => {
        if (installationId === undefined) {
          throw new Error(
            `no GitHub App installation stored for ${job.repo}`,
          );
        }
        return reconcileReview(job, log, clientFor(installationId));
      });
    },
  });
}

export function enqueueManualReview(
  repo: string,
  prNumber: number,
): { id: string; debounced: boolean } {
  const last = latestPostedReview(repo, prNumber);
  const row = getRepo(repo);
  const incremental = row?.review_scope === "incremental" &&
    Boolean(last?.head_sha);
  return enqueue({
    type: "review",
    repo,
    prNumber,
    args: {
      trigger: "manual",
      scope: incremental ? "incremental" : "whole-pr",
      sinceCommit: incremental ? last!.head_sha : undefined,
      round: last ? last.round + 1 : 1,
    },
  });
}
