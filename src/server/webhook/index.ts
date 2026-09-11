import { readConfig } from "../../config.ts";
import { errorResponse } from "../errors.ts";
import { hasDelivery, recordDelivery } from "../../store/deliveries.ts";
import { dispatchGithubEvent } from "../../services/webhook.ts";
import { verifySignature } from "./signature.ts";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

export async function handleWebhookRequest(
  request: Request,
  secret?: string,
): Promise<Response> {
  const raw = new Uint8Array(await request.arrayBuffer());
  if (secret) {
    const header = request.headers.get("x-hub-signature-256");
    if (!await verifySignature(secret, raw, header)) {
      return errorResponse(401, "unauthorized", "bad webhook signature");
    }
  }

  const deliveryId = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event");
  if (!deliveryId || !event) {
    return errorResponse(
      400,
      "bad_request",
      "x-github-delivery and x-github-event are required",
    );
  }
  if (hasDelivery(deliveryId)) {
    return json(200, { outcome: "duplicate" });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return errorResponse(400, "bad_request", "body is not JSON");
  }
  if (
    payload === null || typeof payload !== "object" || Array.isArray(payload)
  ) {
    return errorResponse(400, "bad_request", "body is not a JSON object");
  }

  const config = readConfig();
  const repoFullName =
    (payload.repository as { full_name?: unknown } | undefined)?.full_name;
  const repoName = typeof repoFullName === "string" ? repoFullName : undefined;
  const repoConfig = repoName ? config.repos?.[repoName] : undefined;
  const maxDiffLines = repoConfig?.maxPullRequestChangeLines ??
    config.defaults?.maxPullRequestChangeLines;

  let result;
  try {
    result = dispatchGithubEvent(event, payload, deliveryId, maxDiffLines);
  } catch (error) {
    result = { outcome: "error" as const, reason: String(error) };
  }

  recordDelivery({
    deliveryId,
    event,
    action: typeof payload.action === "string" ? payload.action : undefined,
    repo: result.repo,
    prNumber: result.prNumber,
    outcome: result.outcome,
    reason: result.reason,
  });

  return json(200, {
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.jobId ? { jobId: result.jobId } : {}),
  });
}
