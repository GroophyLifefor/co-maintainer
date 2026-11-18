import { errorResponse } from "../errors.ts";
import { activityFeed, skippedDeliveries } from "../../services/dashboard.ts";
import {
  ACTIVITY_PER_PAGE,
  activityStoreFilter,
  parseActivityQuery,
} from "../pages/activity_query.ts";

export function handleActivityRoute(request: Request, url: URL): Response {
  if (url.pathname === "/api/activity" && request.method === "GET") {
    const query = parseActivityQuery(url.searchParams);
    return Response.json(
      activityFeed(query.page, ACTIVITY_PER_PAGE, activityStoreFilter(query)),
    );
  }
  if (url.pathname === "/api/activity/skipped" && request.method === "GET") {
    return Response.json({ items: skippedDeliveries() });
  }
  return errorResponse(404, "not_found", `no route for ${url.pathname}`);
}
