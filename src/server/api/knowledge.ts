/** The dashboard's clear routes.
 *
 * `DELETE /api/repos/:owner/:repo/knowledge` forgets one repository,
 * `DELETE /api/knowledge` forgets every stored repository. Both share the job
 * negotiation here: a queued job can be canceled and a running review can be
 * aborted (`?onRunning=abort`), but a running `init`/`remake` cannot be
 * stopped, so the route answers 409 and the page waits for it instead. */
import { errorResponse } from "../errors.ts";
import {
  abortRunningReviews,
  cancelQueuedJobs,
  clearRepos,
  clearRepo,
  listStoredRepos,
  repoJobs,
} from "../../services/clear.ts";

function readClearParams(url: URL): { includeCache: boolean; abort: boolean } {
  return {
    includeCache: url.searchParams.get("includeCache") === "1",
    abort: url.searchParams.get("onRunning") === "abort",
  };
}

/** A running setup job ignores the abort signal and would write the guides
 * again after the clear, so it is the one thing the caller cannot skip. */
function isSetupType(type: string): boolean {
  return type !== "review" && type !== "remote_review";
}

/** `undefined` means the clear may go ahead. A 409 carries enough detail for
 * the page to ask the right question: whether to abort reviews and queued
 * jobs, or to wait out a sync. */
export function negotiateJobs(
  repos: string[],
  abort: boolean,
): Response | undefined {
  const jobs = repoJobs(repos);
  if (jobs.queued.length === 0 && jobs.running.length === 0) return undefined;
  if (!abort) {
    return errorResponse(
      409,
      "jobs_running",
      "Jobs are pending for this target.",
      {
        queued: jobs.queued.length,
        running: jobs.running.map((job) => ({
          id: job.id,
          type: job.type,
          abortable: !isSetupType(job.type),
        })),
      },
    );
  }
  const setup = jobs.running.find((job) => isSetupType(job.type));
  if (setup) {
    return errorResponse(
      409,
      "job_not_abortable",
      "A sync is running and cannot be stopped.",
      { id: setup.id, type: setup.type },
    );
  }
  cancelQueuedJobs(repos);
  abortRunningReviews(repos);
  return undefined;
}

export async function handleKnowledgeRoute(
  request: Request,
  url: URL,
): Promise<Response> {
  if (url.pathname !== "/api/knowledge" || request.method !== "DELETE") {
    return errorResponse(404, "not_found", `no route for ${url.pathname}`);
  }
  const { includeCache, abort } = readClearParams(url);
  // The same snapshot is negotiated and cleared, so a repository added in
  // between cannot slip past the job check.
  const repos = await listStoredRepos();
  const conflict = negotiateJobs(repos, abort);
  if (conflict) return conflict;
  const result = await clearRepos(repos, { includeCache });
  return Response.json({ ok: true, ...result });
}

/** Shared by the per-repo route, which knows exactly one repository. */
export async function clearOneRepo(
  fullName: string,
  url: URL,
): Promise<Response> {
  const { includeCache, abort } = readClearParams(url);
  const conflict = negotiateJobs([fullName], abort);
  if (conflict) return conflict;
  const result = await clearRepo(fullName, { includeCache });
  return Response.json({ ok: true, ...result });
}
