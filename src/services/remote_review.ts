import { VERSION } from "../version.ts";
import { CliError } from "../cli/error.ts";
import {
  resolvedFromFirstReview,
  revisionStats,
  sortResolvedFindings,
  summaryCounts,
  toJsonFinding,
} from "../cli/review_result.ts";
import { parseFindings } from "../pr/findings.ts";
import { codegraphToolHandlersForBridge } from "../pr/codegraph_tools.ts";
import { type ReviewExtras, reviewWorkspaceRevision } from "../pr/reviewer.ts";
import {
  buildCarryPromptSection,
  classifyCarryItems,
  guideRebuiltSince,
  incrementalDiffPaths,
  type CarryPrevious,
} from "../review/carry_over.ts";
import { remoteBridgeToolHandlers } from "../remote/tool_bridge.ts";
import { revisionFromSubmitJson } from "../remote/revision_from_submit.ts";
import {
  closeRemoteSession,
  openRemoteSession,
  setRemoteSyncResult,
} from "../remote/server/sessions.ts";
import { readConfig, remoteByokPolicy, resolvedAiToken } from "../config.ts";
import {
  dropByokKey,
  getByokKey,
  hasByokKey,
  registerByokKey,
} from "../remote/server/byok_keys.ts";
import { reviewBlockingFrom } from "../review/blocking.ts";
import { loadGuides } from "../review/guides.ts";
import type { Options } from "../types.ts";
import { withLogSink } from "../util/log.ts";
import { cancel, registerHandler, type LogFn } from "./jobs.ts";
import { recordAiCost } from "./setup.ts";
import {
  addResponseCost,
  costColumns,
  costUsage,
  emptyTally,
  settle,
} from "../util/cost.ts";
import { findRepoByFullName } from "../store/repos.ts";
import {
  deleteRemoteReviewInput,
  findRemoteReviewInputByRequest,
  getRemoteReviewInput,
  insertRemoteReviewInput,
} from "../store/remote_review_inputs.ts";
import {
  insertFinding,
  listCarryableFindingsForReview,
} from "../store/findings.ts";
import {
  deleteSubjectRevision,
  getOrCreateRemoteSubject,
  getSubjectRevision,
  parseRevisionFiles,
  parseVisiblePaths,
  saveSubjectRevision,
} from "../store/subjects.ts";
import {
  getReviewByJobId,
  insertRemoteReview,
  setReviewStatus,
} from "../store/reviews.ts";
import { insertJob, listJobsByQueueKey, setJobStatus } from "../store/jobs.ts";
import { getAppDb } from "../store/app_db.ts";
import type { RemoteTokenRow } from "../store/rows.ts";
import type { JobRow } from "../store/rows.ts";

const REPO_UNAVAILABLE = "Sorry, we could not access this repository.";

/** A remote review failure whose `code` the client can branch on. `runJob`
 * stores `error.message`, so the text is what reaches the client's abort
 * message. */
class RemoteReviewError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RemoteReviewError";
    this.code = code;
  }
}

function remoteQueueKey(repo: string, branch: string, tokenId: string): string {
  return `remote:${repo}:${branch}:${tokenId}`;
}

/** True only for a provider *authentication* rejection: the providers raise
 * `openrouter_unauthorized`, `openai_unauthorized`, `anthropic_unauthorized`
 * and `opencode_unauthorized`. The list is explicit so an unrelated error that
 * happens to end in `_unauthorized` is not relabelled as a bad client key.
 */
function isProviderAuthError(error: unknown): boolean {
  return (
    error instanceof CliError &&
    [
      "openrouter_unauthorized",
      "openai_unauthorized",
      "anthropic_unauthorized",
      "opencode_unauthorized",
    ].includes(error.code)
  );
}

function reviewOptionsForRepo(
  repo: string,
  useCodegraph: boolean,
  aiToken?: string,
): Options {
  const config = readConfig();
  return {
    command: "review",
    repo,
    debug: false,
    logTime: false,
    useCodegraph,
    improveMatrix: 1,
    ghConcurrent: 1,
    aiConcurrent: 3,
    auth: config.auth ?? "gh",
    githubPat: config.githubPat,
    ai: config.ai ?? "openrouter",
    aiToken: aiToken ?? resolvedAiToken(config, config.ai ?? "openrouter"),
    lowModel: config.lowModel,
    highModel: config.highModel,
    synthesisVersion: 16,
    includeCodebase: true,
    includePullRequests: true,
    includePullRequestChanges: true,
    includeCommitHistory: true,
    includeHowRepoWorks: true,
    onlyRequestChangedPr: false,
    reviewBlocking: reviewBlockingFrom(config.reviewBlocking),
  };
}

function supersedeActiveRemoteJobs(
  queueKey: string,
  supersededBy: string,
): void {
  for (const job of listJobsByQueueKey(queueKey, ["queued", "running"])) {
    if (job.id === supersededBy) continue;
    // A superseded job never becomes terminal through `runJob`, so its BYOK
    // key must be dropped here or it would sit in memory for the process
    // lifetime, and its input row must go too so a later retry is not blocked
    // by a dead row.
    dropByokKey(job.id);
    if (job.status === "running") {
      cancel(job.id, "superseded");
    } else {
      deleteRemoteReviewInput(job.id);
      setJobStatus(job.id, "canceled", {
        superseded_by: supersededBy,
        cancel_reason: "superseded",
      });
    }
  }
}

export function submitRemoteReview(
  token: RemoteTokenRow,
  body: Record<string, unknown>,
):
  | { jobId: string; reviewId: string }
  | { error: string; status: number; code: string } {
  const requestId = String(body.requestId);
  const existing = findRemoteReviewInputByRequest(token.id, requestId);
  if (existing) {
    // A retried submit must not change who pays: the key is not in the body
    // this time, so re-register it from the first request's recorded policy.
    const bill = existing.billed_to === "byok" ? "byok" : "server";
    if (bill === "byok" && !hasByokKey(existing.job_id)) {
      return {
        error: "Your key was not kept. Submit the review again.",
        status: 409,
        code: "byok_key_lost",
      };
    }
    const review = getReviewByJobId(existing.job_id);
    if (review) {
      return { jobId: existing.job_id, reviewId: review.id };
    }
  }

  const repoRow = findRepoByFullName(String(body.repo));
  if (!repoRow || repoRow.active !== 1) {
    return { error: REPO_UNAVAILABLE, status: 404, code: "repo_unavailable" };
  }

  const byokRaw = body.byok as { key?: unknown } | undefined;
  const submittedKey =
    byokRaw && typeof byokRaw.key === "string" ? byokRaw.key : undefined;
  const policy = remoteByokPolicy();
  if (policy === "off" && submittedKey !== undefined) {
    return {
      error: "This server does not accept your own key.",
      status: 403,
      code: "byok_not_allowed",
    };
  }
  if (policy === "require" && submittedKey === undefined) {
    return {
      error: "This server requires your own key. Run with --remote-byok.",
      status: 403,
      code: "byok_required",
    };
  }
  const billedTo: "server" | "byok" =
    submittedKey !== undefined ? "byok" : "server";

  if (typeof body.branch !== "string") {
    return {
      error: "branch must be a string",
      status: 400,
      code: "bad_request",
    };
  }
  const branch = body.branch;
  const fresh = body.fresh === true;
  const subject = getOrCreateRemoteSubject(repoRow.full_name, branch, token.id);
  if (fresh) deleteSubjectRevision(subject.id);

  const jobId = crypto.randomUUID();
  const reviewId = crypto.randomUUID();
  const queueKey = remoteQueueKey(repoRow.full_name, branch, token.id);
  supersedeActiveRemoteJobs(queueKey, jobId);

  const revision = body.revision ?? {};
  const capabilities = body.capabilities ?? { tools: [] };
  insertRemoteReviewInput({
    jobId,
    revisionJson: JSON.stringify(revision),
    capabilitiesJson: JSON.stringify(capabilities),
    requestId,
    tokenId: token.id,
    billedTo,
  });

  // The review and job rows go in one transaction so a failure cannot leave a
  // partially written submission behind: no review with no job, and no queued
  // job whose input row points a retry at a job that never really started.
  // The key is registered only after COMMIT, so it never outlives a failed
  // setup.
  const config = readConfig();
  const db = getAppDb();
  db.exec("BEGIN");
  try {
    insertRemoteReview({
      id: reviewId,
      subjectId: subject.id,
      repo: repoRow.full_name,
      branch,
      tokenId: token.id,
      tokenName: token.name,
      jobId,
      scope: "remote",
      model: config.highModel ?? "unknown",
    });

    insertJob({
      id: jobId,
      type: "remote_review",
      repo: repoRow.full_name,
      queueKey,
      args: { subjectId: subject.id, requestId, reviewId },
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    // Nothing of this submission survives, so the input row must go too, or a
    // retry with the same request id would find a row whose key is gone and be
    // told byok_key_lost.
    deleteRemoteReviewInput(jobId);
    throw error;
  }

  // The key is pulled out of the body before anything persists it: it lives
  // only in this process's memory, tied to the job.
  if (billedTo === "byok" && submittedKey !== undefined) {
    registerByokKey(jobId, submittedKey);
  }

  openRemoteSession({
    jobId,
    reviewId,
    tokenId: token.id,
    subjectId: subject.id,
  });

  return { jobId, reviewId };
}

export function registerRemoteReviewHandler(): void {
  registerHandler("remote_review", {
    async run(job: JobRow, log: LogFn, signal: AbortSignal) {
      const args = JSON.parse(job.args) as {
        reviewId?: string;
        subjectId?: string;
      };
      const reviewId = args.reviewId;
      const subjectId = args.subjectId;
      if (!reviewId) throw new Error("remote review missing reviewId");

      const input = getRemoteReviewInput(job.id);
      if (!input) throw new Error("remote review input missing");

      const review = getReviewByJobId(job.id);
      if (!review) throw new Error("remote review row missing");

      setReviewStatus(reviewId, "running");
      log("info", `remote review started for ${job.repo}`);

      let completed = false;
      // A BYOK review runs on the client's key, never the server's. If the key
      // is gone (a restart between submit and run), stop with a typed message
      // instead of silently falling back to the server key.
      const billedTo = input.billed_to === "byok" ? "byok" : "server";
      const byokKey = billedTo === "byok" ? getByokKey(job.id) : undefined;
      try {
        if (billedTo === "byok" && byokKey === undefined) {
          throw new RemoteReviewError(
            "byok_key_lost",
            "Your key was not kept across a server restart. Submit the review again.",
          );
        }
        const revision = revisionFromSubmitJson(
          JSON.parse(input.revision_json),
        );
        const caps = JSON.parse(input.capabilities_json) as {
          tools?: { name: string }[];
        };
        const allowed = new Set(
          (caps.tools ?? [])
            .map((tool) => tool.name)
            .filter((name) => typeof name === "string" && name),
        );
        const useCodegraph = allowed.size > 0;
        const options = reviewOptionsForRepo(job.repo, useCodegraph, byokKey);
        // A BYOK client brings a key but not models, so a server with no
        // models cannot run its review either.
        if (
          !options.aiToken ||
          options.ai === "none" ||
          !options.lowModel ||
          !options.highModel
        ) {
          throw new Error("server AI is not configured for remote review");
        }
        const billed: "server" | "byok" =
          byokKey !== undefined ? "byok" : "server";

        const extras: ReviewExtras = {};
        if (subjectId) {
          const subjectRevision = getSubjectRevision(subjectId);
          // A guide rebuilt after the previous review invalidates its verdicts
          // and its "unchanged" suppression: start fresh so a
          // stale finding cannot mask a new one.
          const guideRebuilt =
            subjectRevision !== undefined &&
            guideRebuiltSince(
              subjectRevision.guide_built_at,
              (await loadGuides(job.repo)).guideBuiltAt,
            );
          if (subjectRevision && !guideRebuilt) {
            const prevFiles = parseRevisionFiles(subjectRevision);
            const { unchanged } = incrementalDiffPaths(revision, prevFiles);
            extras.unchangedPaths = unchanged;
            const storedRows = listCarryableFindingsForReview(
              subjectRevision.review_id,
            );
            const carryPrevious: CarryPrevious = {
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
              })),
              guideBuiltAt: subjectRevision.guide_built_at,
            };
            const carryItems = classifyCarryItems(
              carryPrevious,
              revision,
              carryPrevious.visiblePaths,
              null,
            );
            extras.carryPrompt = buildCarryPromptSection(carryItems, revision);
          }
        }
        if (useCodegraph) {
          const schemas = codegraphToolHandlersForBridge();
          extras.prepareCodegraphTools = async () =>
            remoteBridgeToolHandlers(job.id, signal, allowed, schemas);
        }

        const started = performance.now();
        let tokensIn = 0;
        let tokensOut = 0;
        const costTally = emptyTally();
        const result = await withLogSink(
          (phase, message) => log("info", `[${phase}] ${message}`),
          () =>
            reviewWorkspaceRevision(
              revision,
              options,
              "remote",
              async (response) => {
                tokensIn += response.tokensIn;
                tokensOut += response.tokensOut;
                addResponseCost(costTally, response);
                await recordAiCost(job.repo, "remote_review", response);
              },
              undefined,
              (message) => log("info", message),
              extras,
            ),
        );

        if (signal.aborted) return;

        const parsed = parseFindings(result.text);
        const filesByPath = new Map(
          revision.files.map((file) => [file.path, { patch: file.patch }]),
        );
        const findings = sortResolvedFindings(
          resolvedFromFirstReview(parsed, filesByPath),
        );
        const durationMs = Math.round(performance.now() - started);
        const blockingMode = reviewBlockingFrom(options.reviewBlocking);

        setRemoteSyncResult(job.id, {
          subject: {
            repo: job.repo,
            branch: review.branch,
            prNumber: null,
          },
          revision: revisionStats(revision),
          guide: { builtAt: result.guideBuiltAt },
          codegraph: { state: result.codegraphState },
          summary: summaryCounts(findings, blockingMode),
          findings: findings.map((row) => toJsonFinding(row, blockingMode)),
          usage: {
            tokensIn,
            tokensOut,
            ...costUsage(costTally),
            billedTo: billed,
          },
          remote: { jobId: job.id, reviewId, clientVersion: VERSION },
        });

        setReviewStatus(reviewId, "done", {
          findings_count: findings.length,
          guide_built_at: result.guideBuiltAt,
          duration_ms: durationMs,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          billed_to: billed,
          ...costColumns(settle(costTally)),
        });
        if (subjectId) {
          saveSubjectRevision({
            subjectId,
            reviewId,
            files: revision.files,
            visiblePaths: [...result.visiblePaths],
            guideBuiltAt: result.guideBuiltAt,
          });
          for (const row of findings) {
            insertFinding({
              id: row.id,
              reviewId,
              severity: row.severity,
              path: row.path ?? undefined,
              lineFrom: row.lineFrom ?? undefined,
              lineTo: row.lineTo ?? undefined,
              title: row.title,
              bodyMd: row.bodyMd,
              anchorText: row.anchorText,
              state: row.state,
              closeReason: row.closeReason ?? null,
            });
          }
        }
        deleteRemoteReviewInput(job.id);
        closeRemoteSession(job.id);
        completed = true;
        log("info", `remote review finished (${findings.length} findings)`);
      } catch (error) {
        // Only an authentication rejection proves the client's key is bad, so
        // only that becomes `byok_rejected`. A provider outage, a parse error
        // or a local failure must surface as itself rather than telling the
        // user their key was refused. `byok_key_lost` is thrown before this
        // try, so it is not remapped.
        if (
          byokKey !== undefined &&
          !signal.aborted &&
          isProviderAuthError(error)
        ) {
          throw new RemoteReviewError(
            "byok_rejected",
            "The AI provider rejected your own key.",
          );
        }
        throw error;
      } finally {
        dropByokKey(job.id);
        if (!completed) {
          // Reached on failure and on the aborted early return above.
          setReviewStatus(reviewId, signal.aborted ? "aborted" : "failed", {
            billed_to: billedTo,
          });
          deleteRemoteReviewInput(job.id);
          closeRemoteSession(job.id);
        }
      }
    },
  });
}
