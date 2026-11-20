import { errorResponse } from "../errors.ts";
import { audit } from "../../services/audit.ts";
import { activityFeed, skippedDeliveries } from "../../services/dashboard.ts";
import {
  dismissAll,
  dismissRows,
  retryRows,
} from "../../services/activity_actions.ts";
import { readJsonObject } from "./json_body.ts";
import { activityStamp } from "../../store/activity.ts";
import {
  ACTIVITY_PER_PAGE,
  activityStoreFilter,
  parseActivityQuery,
} from "../pages/activity_query.ts";

const KEY = /^(job|review):[\w.:-]{1,200}$/;

/** The row keys of a request body, checked: at most 200, each `job:<id>` or
 * `review:<id>`. */
function keysOf(body: Record<string, unknown>): string[] | Response {
  const keys = body.keys;
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.length > 200 ||
    !keys.every((key) => typeof key === "string" && KEY.test(key))
  ) {
    return errorResponse(
      422,
      "invalid_keys",
      "keys must be 1 to 200 row keys such as job:<id>",
    );
  }
  return keys as string[];
}

export async function handleActivityRoute(
  request: Request,
  url: URL,
): Promise<Response> {
  if (url.pathname === "/api/activity" && request.method === "GET") {
    const query = parseActivityQuery(url.searchParams);
    return Response.json(
      activityFeed(query.page, ACTIVITY_PER_PAGE, activityStoreFilter(query)),
    );
  }
  // The open Activity page polls this and fetches the list only when it
  // changed, instead of fetching the whole page every few seconds.
  if (url.pathname === "/api/activity/stamp" && request.method === "GET") {
    return Response.json(
      { stamp: activityStamp() },
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (url.pathname === "/api/activity/skipped" && request.method === "GET") {
    return Response.json({ items: skippedDeliveries() });
  }
  if (url.pathname === "/api/activity/dismiss" && request.method === "POST") {
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    // Dismiss all, of one repository when the list was filtered to one.
    if (body.all === true) {
      const repo =
        typeof body.repo === "string" && body.repo.trim()
          ? body.repo.trim()
          : undefined;
      const dismissed = dismissAll(repo);
      if (dismissed > 0) {
        audit("dismiss", "Dismissed all failures", { target: repo });
      }
      return Response.json({ dismissed });
    }
    const keys = keysOf(body);
    if (keys instanceof Response) return keys;
    const dismissed = dismissRows(keys);
    if (dismissed > 0) {
      audit(
        "dismiss",
        keys.length === 1
          ? "Dismissed a failure"
          : `Dismissed ${keys.length} failures`,
      );
    }
    return Response.json({ dismissed });
  }
  if (url.pathname === "/api/activity/retry" && request.method === "POST") {
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const keys = keysOf(body);
    if (keys instanceof Response) return keys;
    // `defaultModel: true` is the "Retry with <configured model>" action.
    const result = retryRows(keys, {
      defaultModel: body.defaultModel === true,
    });
    if (result.jobIds.length > 0) {
      audit(
        "review",
        result.jobIds.length === 1
          ? "Retried a failure"
          : `Retried ${result.jobIds.length} failures`,
      );
    }
    return Response.json(result);
  }
  return errorResponse(404, "not_found", `no route for ${url.pathname}`);
}
