import { errorResponse } from "../errors.ts";
import {
  createRemoteToken,
  deleteRemoteToken,
  listRemoteTokens,
  setRemoteTokenActive,
} from "../../services/remote_tokens.ts";
import { getRemoteToken } from "../../store/remote_tokens.ts";

export async function handleRemoteTokensRoute(
  request: Request,
  url: URL,
): Promise<Response> {
  if (url.pathname === "/api/remote-tokens" && request.method === "GET") {
    const items = listRemoteTokens().map((row) => ({
      id: row.id,
      name: row.name,
      active: row.active === 1,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      reviews30d: 0,
      cost30d: 0,
    }));
    return Response.json(items);
  }

  if (url.pathname === "/api/remote-tokens" && request.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "bad_request", "expected a JSON body");
    }
    if (typeof body.name !== "string") {
      return errorResponse(400, "bad_request", "name is required");
    }
    try {
      const created = await createRemoteToken(body.name);
      return Response.json(created, { status: 201 });
    } catch (error) {
      const message = String(error);
      if (message.includes("name_taken")) {
        return errorResponse(409, "name_taken", "token name is already in use");
      }
      return errorResponse(400, "bad_request", message.replace(/^Error: /, ""));
    }
  }

  const itemMatch = /^\/api\/remote-tokens\/([^/]+)$/.exec(url.pathname);
  if (!itemMatch) {
    return errorResponse(404, "not_found", `no route for ${url.pathname}`);
  }
  const id = itemMatch[1];
  const row = getRemoteToken(id);
  if (!row) {
    return errorResponse(404, "not_found", "token not found");
  }

  if (request.method === "PATCH") {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "bad_request", "expected a JSON body");
    }
    if (typeof body.active !== "boolean") {
      return errorResponse(400, "bad_request", "active must be a boolean");
    }
    setRemoteTokenActive(id, body.active);
    return Response.json({ ok: true });
  }

  if (request.method === "DELETE") {
    deleteRemoteToken(id);
    return new Response(null, { status: 204 });
  }

  return errorResponse(404, "not_found", `no route for ${url.pathname}`);
}
