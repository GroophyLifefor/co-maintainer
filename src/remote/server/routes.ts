import { VERSION } from "../../version.ts";
import { cloneDir, readConfig, remoteByokPolicy } from "../../config.ts";
import { resolveDefaultBranchName } from "../../git/default_branch.ts";
import { runCommand } from "../../pr/checkout.ts";
import { loadGuides } from "../../review/guides.ts";
import {
  isLockedOut,
  readBearerToken,
  recordAuthFailure,
} from "../../server/auth.ts";
import { errorResponse } from "../../server/errors.ts";
import { lookupRemoteBearer } from "../../services/remote_tokens.ts";
import { findRepoByFullName } from "../../store/repos.ts";
import type { RemoteTokenRow } from "../../store/rows.ts";
import {
  MIN_CLIENT_SCHEMA,
  REMOTE_CLI_UPGRADE_COMMAND,
  REMOTE_MAX_BODY_BYTES,
  REMOTE_SCHEMA_VERSION,
  REMOTE_SYNC_INTERVAL_SECONDS,
} from "../schema.ts";
import { readBoundedJson } from "./body.ts";
import { submitRemoteReview } from "../../services/remote_review.ts";
import { queuePush } from "../../services/push_review.ts";
import { revisionFromSubmitJson } from "../revision_from_submit.ts";
import { handleRemoteCancel, handleRemoteSync } from "./sync.ts";
import { parseRepoQuery, readRemoteGuides } from "./guides.ts";
import {
  validateHandshakeRequest,
  validateSubmitRequest,
} from "../validate.ts";
import { stat } from "../../util/runtime.ts";

const REPO_UNAVAILABLE = "Sorry, we could not access this repository.";

async function authenticateRemote(
  request: Request,
  ip: string,
): Promise<RemoteTokenRow | Response> {
  if (isLockedOut(ip)) {
    return errorResponse(429, "locked_out", "too many failed attempts");
  }
  const bearer = readBearerToken(request);
  if (!bearer) {
    recordAuthFailure(ip);
    return errorResponse(401, "token_invalid", "invalid or missing token");
  }
  const status = await lookupRemoteBearer(bearer);
  if (status === "invalid") {
    recordAuthFailure(ip);
    return errorResponse(401, "token_invalid", "invalid or missing token");
  }
  if (status === "inactive") {
    return errorResponse(403, "token_inactive", "token is inactive");
  }
  return status;
}

export async function defaultBranchForRepo(
  fullName: string,
): Promise<string | null> {
  try {
    const dir = cloneDir(fullName);
    await stat(dir);
    const name = await resolveDefaultBranchName(dir, "origin", runCommand);
    return name ?? null;
  } catch {
    return null;
  }
}

async function handleHandshake(
  request: Request,
  ip: string,
): Promise<Response> {
  const parsed = await readBoundedJson(request, REMOTE_MAX_BODY_BYTES);
  if (!parsed.ok) {
    return errorResponse(parsed.status, parsed.code, parsed.message);
  }
  const validation = validateHandshakeRequest(parsed.value);
  if (validation) {
    return errorResponse(400, "bad_request", validation);
  }
  const record = parsed.value as Record<string, unknown>;
  const schemaVersion = record.schemaVersion as number;
  if (schemaVersion < MIN_CLIENT_SCHEMA) {
    return errorResponse(
      426,
      "upgrade_required",
      "This co-maintainer CLI is too old for the server.",
      {
        minClientSchema: MIN_CLIENT_SCHEMA,
        serverSchema: REMOTE_SCHEMA_VERSION,
        upgradeCommand: REMOTE_CLI_UPGRADE_COMMAND,
      },
    );
  }

  const auth = await authenticateRemote(request, ip);
  if (auth instanceof Response) return auth;

  const repoRow = findRepoByFullName(String(record.repo));
  if (!repoRow || repoRow.active !== 1) {
    return errorResponse(404, "repo_unavailable", REPO_UNAVAILABLE);
  }
  const guides = await loadGuides(repoRow.full_name);
  // A push review decides about a repository with no guides itself, so the
  // commit can get a skipped check run when the App covers it.
  if (!guides.shortGuide && !guides.skill && record.purpose !== "push") {
    // The status and the code stay as they were so an older client still
    // reads this as a refusal. Only the text says what is missing.
    return errorResponse(
      409,
      "not_initialized",
      `Review guides are missing for ${repoRow.full_name} on this server.`,
    );
  }

  const config = readConfig();
  const timeoutSeconds = config.remoteSyncTimeoutSeconds ?? 10;
  const toolLimit = config.remoteToolOutputMaxChars ?? null;
  const policy = remoteByokPolicy(config);

  return Response.json({
    schemaVersion: REMOTE_SCHEMA_VERSION,
    minClientSchema: MIN_CLIENT_SCHEMA,
    serverVersion: VERSION,
    token: { name: auth.name },
    repo: {
      fullName: repoRow.full_name,
      defaultBranch: await defaultBranchForRepo(repoRow.full_name),
      guideBuiltAt: guides.guideBuiltAt,
    },
    sync: {
      intervalSeconds: REMOTE_SYNC_INTERVAL_SECONDS,
      timeoutSeconds,
    },
    limits: {
      maxBodyBytes: REMOTE_MAX_BODY_BYTES,
      toolOutputMaxChars: toolLimit,
    },
    // Additive advertisement: a 0.5.0 client ignores these, and an
    // older server never sends them, so the client gates on `features`. No key,
    // model, or other secret is ever echoed here.
    features: ["byok", "push", "intent"],
    byok: { policy },
    ai: { provider: config.ai ?? "openrouter" },
  });
}

async function handleSync(
  request: Request,
  ip: string,
  jobId: string,
): Promise<Response> {
  const auth = await authenticateRemote(request, ip);
  if (auth instanceof Response) return auth;

  const parsed = await readBoundedJson(request, REMOTE_MAX_BODY_BYTES);
  if (!parsed.ok) {
    return errorResponse(parsed.status, parsed.code, parsed.message);
  }
  return handleRemoteSync(jobId, auth, parsed.value as Record<string, unknown>);
}

async function handleSubmit(request: Request, ip: string): Promise<Response> {
  const auth = await authenticateRemote(request, ip);
  if (auth instanceof Response) return auth;

  const parsed = await readBoundedJson(request, REMOTE_MAX_BODY_BYTES);
  if (!parsed.ok) {
    return errorResponse(parsed.status, parsed.code, parsed.message);
  }
  const validation = validateSubmitRequest(parsed.value);
  if (validation) {
    return errorResponse(400, "bad_request", validation);
  }

  const record = parsed.value as Record<string, unknown>;
  if (record.push !== undefined) return await submitPush(record);

  const result = submitRemoteReview(auth, record);
  if ("error" in result) {
    return errorResponse(result.status, result.code, result.error);
  }
  return Response.json(
    {
      schemaVersion: REMOTE_SCHEMA_VERSION,
      jobId: result.jobId,
      reviewId: result.reviewId,
    },
    { status: 202 },
  );
}

/** `review --remote --range`: a push to review on the server. The review
 * does not depend on this client staying connected, so it opens no remote
 * session and offers no tool bridge. */
async function submitPush(record: Record<string, unknown>): Promise<Response> {
  const push = record.push as { before: string; after: string; ref: string };
  const repoRow = findRepoByFullName(String(record.repo));
  if (!repoRow || repoRow.active !== 1) {
    return errorResponse(404, "repo_unavailable", REPO_UNAVAILABLE);
  }
  // Commit watch reviews the default branch only, as the App webhook does.
  // A feature branch would open and close issues against unmerged code.
  const defaultBranch = await defaultBranchForRepo(repoRow.full_name);
  if (defaultBranch && push.ref !== `refs/heads/${defaultBranch}`) {
    return errorResponse(
      409,
      "not_default_branch",
      `Commit watch reviews pushes to ${defaultBranch} only.`,
    );
  }
  let revision;
  try {
    revision = revisionFromSubmitJson(record.revision);
  } catch (error) {
    return errorResponse(400, "bad_request", String(error));
  }
  const outcome = queuePush({
    repo: repoRow.full_name,
    before: push.before,
    after: push.after,
    ref: push.ref,
    source: "ci",
    revision,
  });
  switch (outcome.kind) {
    case "enqueued":
    case "attached":
      return Response.json(
        {
          schemaVersion: REMOTE_SCHEMA_VERSION,
          jobId: outcome.jobId,
          reviewId: outcome.reviewId,
          attached: outcome.kind === "attached",
        },
        { status: 202 },
      );
    case "no_changes":
      return Response.json(
        { schemaVersion: REMOTE_SCHEMA_VERSION, noChanges: true },
        { status: 200 },
      );
    case "extend":
      return errorResponse(
        409,
        "range_extend",
        "A waiting push review was merged into this one. Send the wider range.",
        { before: outcome.before },
      );
    case "skipped":
      if (outcome.reason === "not-initialized") {
        return errorResponse(
          409,
          outcome.checkRun ? "not_initialized_skipped" : "not_initialized",
          outcome.message,
        );
      }
      return errorResponse(409, "push_skipped", outcome.message);
  }
}

async function handleGuides(
  request: Request,
  ip: string,
  url: URL,
): Promise<Response> {
  const auth = await authenticateRemote(request, ip);
  if (auth instanceof Response) return auth;

  const parsed = parseRepoQuery(url.searchParams.get("repo"));
  if ("error" in parsed) {
    return errorResponse(400, "bad_request", parsed.error);
  }
  const repoRow = findRepoByFullName(parsed.repo);
  if (!repoRow || repoRow.active !== 1) {
    return errorResponse(404, "repo_unavailable", REPO_UNAVAILABLE);
  }
  const { guides, guideBuiltAt } = await readRemoteGuides(repoRow.full_name);
  return Response.json({
    schemaVersion: REMOTE_SCHEMA_VERSION,
    repo: { fullName: repoRow.full_name },
    guideBuiltAt,
    guides,
  });
}

export async function handleRemoteRoute(
  request: Request,
  url: URL,
  remoteAddr: string,
): Promise<Response> {
  if (url.pathname === "/api/remote/handshake" && request.method === "POST") {
    return await handleHandshake(request, remoteAddr);
  }

  if (url.pathname === "/api/remote/guides" && request.method === "GET") {
    return await handleGuides(request, remoteAddr, url);
  }

  if (url.pathname === "/api/remote/reviews" && request.method === "POST") {
    return await handleSubmit(request, remoteAddr);
  }

  const syncMatch = /^\/api\/remote\/reviews\/([^/]+)\/sync$/.exec(
    url.pathname,
  );
  if (syncMatch && request.method === "POST") {
    return await handleSync(request, remoteAddr, syncMatch[1]!);
  }

  const reviewMatch = /^\/api\/remote\/reviews\/([^/]+)$/.exec(url.pathname);
  if (reviewMatch && request.method === "DELETE") {
    const auth = await authenticateRemote(request, remoteAddr);
    if (auth instanceof Response) return auth;
    return handleRemoteCancel(reviewMatch[1]!, auth);
  }

  return errorResponse(404, "not_found", `no route for ${url.pathname}`);
}
