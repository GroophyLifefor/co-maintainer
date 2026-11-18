import { errorResponse } from "../errors.ts";
import { statsForRange } from "../../services/dashboard.ts";
import { parseUsageQuery } from "../pages/usage_query.ts";

export function handleAnalyticsRoute(request: Request, url: URL): Response {
  if (url.pathname === "/api/analytics" && request.method === "GET") {
    const query = parseUsageQuery(url.searchParams);
    return Response.json(statsForRange(query.range, query));
  }
  return errorResponse(404, "not_found", `no route for ${url.pathname}`);
}
