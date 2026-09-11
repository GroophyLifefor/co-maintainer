import { errorResponse } from "../errors.ts";
import { statsForRange } from "../../services/dashboard.ts";

export function handleAnalyticsRoute(request: Request, url: URL): Response {
  if (url.pathname === "/api/analytics" && request.method === "GET") {
    const range = url.searchParams.get("range") ?? "30d";
    return Response.json(statsForRange(range));
  }
  return errorResponse(404, "not_found", `no route for ${url.pathname}`);
}
