/** `POST /api/findings/:id` with `{ "action": "close" | "reopen", "reason" }`:
 * a maintainer closes a finding or opens it again from the dashboard. */
import { errorResponse } from "../errors.ts";
import { setFindingClosed } from "../../services/finding_actions.ts";
import { currentAuditActor } from "../../services/audit.ts";
import { USERNAME } from "../auth.ts";

export async function handleFindingsRoute(
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  const match = /^\/api\/findings\/([^/]+)$/.exec(url.pathname);
  if (!match) return undefined;
  if (request.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "use POST");
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "bad_request", "expected a JSON body");
  }
  if (body.action !== "close" && body.action !== "reopen") {
    return errorResponse(
      422,
      "invalid_action",
      "action must be close or reopen",
    );
  }
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : undefined;
  const actor = currentAuditActor();
  const result = await setFindingClosed({
    findingId: decodeURIComponent(match[1]!),
    close: body.action === "close",
    reason,
    // The password sign-in is the shared `admin` user, not a GitHub login.
    by: !actor || actor === USERNAME ? "a maintainer on the dashboard" : actor,
  });
  if (!result.ok) return errorResponse(409, "not_changed", result.reason);
  return Response.json(result);
}
