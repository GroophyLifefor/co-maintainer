/** `/api/update`: what the Updates card shows, and the Update button. */
import { errorResponse } from "../errors.ts";
import { readJsonObject } from "./json_body.ts";
import { startUpdate, updateNotice } from "../../services/update_check.ts";
import { checkWhatsNew } from "../../services/whats_new.ts";
import { audit } from "../../services/audit.ts";

export async function handleUpdateRoute(
  request: Request,
  url: URL,
): Promise<Response> {
  // Only an admin's click reaches this, after the dashboard said it asks
  // github.com. POST, so no link or prefetch can start it.
  if (url.pathname === "/api/whats-new" && request.method === "POST") {
    try {
      return Response.json(await checkWhatsNew());
    } catch (error) {
      return errorResponse(
        502,
        "github_unreachable",
        `Could not read the latest version from GitHub: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (url.pathname === "/api/update" && request.method === "GET") {
    return Response.json(updateNotice());
  }
  if (url.pathname === "/api/update" && request.method === "POST") {
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    if (typeof body.version !== "string" || !body.version.trim()) {
      return errorResponse(400, "bad_request", "version is required");
    }
    const version = body.version.trim();
    const result = await startUpdate(version);
    if (!result.ok) {
      return errorResponse(422, "update_refused", result.problem);
    }
    audit("update", `Started an update to ${version}`, {
      changes: [{ setting: "version", from: result.state.from, to: version }],
    });
    return Response.json(result.state);
  }
  return errorResponse(404, "not_found", `no route for ${url.pathname}`);
}
