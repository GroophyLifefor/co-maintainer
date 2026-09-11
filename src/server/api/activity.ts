import { errorResponse } from "../errors.ts";
import { activityFeed, skippedDeliveries } from "../../services/dashboard.ts";

export function handleActivityRoute(request: Request, url: URL): Response {
  if (url.pathname === "/api/activity" && request.method === "GET") {
    const page = Number(url.searchParams.get("page") ?? 1);
    return Response.json(activityFeed(page, 20));
  }
  if (url.pathname === "/api/activity/skipped" && request.method === "GET") {
    return Response.json({ items: skippedDeliveries() });
  }
  return errorResponse(404, "not_found", `no route for ${url.pathname}`);
}
