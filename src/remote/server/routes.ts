import denoConfig from "../../../deno.json" with { type: "json" };
import { cloneDir, readConfig } from "../../config.ts";
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
import { validateHandshakeRequest, validateSubmitRequest } from "../validate.ts";

const REPO_UNAVAILABLE =
  "Sorry, we could not access this repository.";

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

async function defaultBranchForRepo(fullName: string): Promise<string | null> {
  try {
    const dir = cloneDir(fullName);
    await Deno.stat(dir);
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
  if (!guides.shortGuide && !guides.skill) {
    return errorResponse(409, "not_initialized", REPO_UNAVAILABLE);
  }

  const config = readConfig();
  const timeoutSeconds = config.remoteSyncTimeoutSeconds ?? 10;
  const toolLimit = config.remoteToolOutputMaxChars ?? null;

  return Response.json({
    schemaVersion: REMOTE_SCHEMA_VERSION,
    minClientSchema: MIN_CLIENT_SCHEMA,
    serverVersion: denoConfig.version,
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
  });
}

async function handleSubmit(
  request: Request,
  ip: string,
): Promise<Response> {
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

  const result = submitRemoteReview(auth, parsed.value as Record<string, unknown>);
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

export async function handleRemoteRoute(
  request: Request,
  url: URL,
  remoteAddr: string,
): Promise<Response> {
  if (url.pathname === "/api/remote/handshake" && request.method === "POST") {
    return await handleHandshake(request, remoteAddr);
  }

  if (url.pathname === "/api/remote/reviews" && request.method === "POST") {
    return await handleSubmit(request, remoteAddr);
  }

  const syncMatch = /^\/api\/remote\/reviews\/([^/]+)\/sync$/.exec(
    url.pathname,
  );
  if (syncMatch && request.method === "POST") {
    return errorResponse(
      501,
      "not_implemented",
      "Remote review sync is not implemented yet",
    );
  }

  const reviewMatch = /^\/api\/remote\/reviews\/([^/]+)$/.exec(url.pathname);
  if (reviewMatch && request.method === "DELETE") {
    return errorResponse(
      501,
      "not_implemented",
      "Remote review cancel is not implemented yet",
    );
  }

  return errorResponse(404, "not_found", `no route for ${url.pathname}`);
}
