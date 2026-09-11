/** The log stream is meant to be consumed with `fetch()` and a manual
 * reader, not the native `EventSource` API — `EventSource` cannot set an
 * `Authorization` header, and every other `/api/*` route needs one. */
import { errorResponse } from "../errors.ts";
import { cancel, getLogsSince, subscribeToLogs } from "../../services/jobs.ts";
import { getJob, listJobs } from "../../store/jobs.ts";
import type { JobLogRow } from "../../store/rows.ts";

const ROUTE = /^\/api\/jobs(?:\/([^/]+)(?:\/(logs\/stream|cancel))?)?$/;

export function handleJobsRoute(request: Request, url: URL): Response {
  const match = ROUTE.exec(url.pathname);
  if (!match) {
    return errorResponse(404, "not_found", `no route for ${url.pathname}`);
  }
  const [, jobId, sub] = match;

  if (!jobId && request.method === "GET") {
    return Response.json({
      items: listJobs({
        status: url.searchParams.get("status") ?? undefined,
        repo: url.searchParams.get("repo") ?? undefined,
      }),
    });
  }

  if (jobId && !sub && request.method === "GET") {
    const job = getJob(jobId);
    if (!job) return errorResponse(404, "not_found", "no such job");
    return Response.json({ ...job, logs: getLogsSince(jobId).slice(-50) });
  }

  if (jobId && sub === "cancel" && request.method === "POST") {
    if (!getJob(jobId)) return errorResponse(404, "not_found", "no such job");
    return Response.json({ ok: cancel(jobId) });
  }

  if (jobId && sub === "logs/stream" && request.method === "GET") {
    const from = Number(url.searchParams.get("from") ?? 0);
    return streamLogs(jobId, Number.isFinite(from) ? from : 0);
  }

  return errorResponse(404, "not_found", `no route for ${url.pathname}`);
}

function streamLogs(jobId: string, fromSeq: number): Response {
  const job = getJob(jobId);
  if (!job) return errorResponse(404, "not_found", "no such job");

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (line: JobLogRow) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(
              `id: ${line.seq}\ndata: ${JSON.stringify(line)}\n\n`,
            ),
          );
        } catch {
          closed = true;
        }
      };
      for (const line of getLogsSince(jobId, fromSeq)) send(line);
      const current = getJob(jobId);
      if (current && ["done", "failed", "canceled"].includes(current.status)) {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the client disconnecting
        }
        return;
      }
      unsubscribe = subscribeToLogs(jobId, send);
    },
    cancel() {
      // The client disconnected — stop pushing to it.
      closed = true;
      unsubscribe?.();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
