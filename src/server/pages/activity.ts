import { empty, html, layout, money, skSlot, text, when } from "./layout.ts";
import { formatCost } from "./cost.ts";
import { crumb, icon, pageHeader } from "./ui.ts";
import { readConfig, resolveAppPrivateKey } from "../../config.ts";
import type {
  activityFeed,
  runningJobs,
  skippedDeliveries,
} from "../../services/dashboard.ts";
import { getLogsSince } from "../../services/jobs.ts";
import {
  listRateLimitWaits,
  summarizeRateLimitWaits,
} from "../../services/rate_limit.ts";
import { getReviewByJobId } from "../../store/reviews.ts";
import {
  rateLimitWaitDetails,
  rateLimitWaitNotice,
} from "./rate_limit_waits.ts";
import type { JobLogRow, JobRow, ReviewRow } from "../../store/rows.ts";

/** True for the skips a policy left waiting on a maintainer's request. */
export function isWaitingForRequest(reason: string | null): boolean {
  return Boolean(reason?.endsWith("waiting for a maintainer request."));
}

function skipReason(reason: string | null): string {
  switch (reason) {
    case "draft":
      return "Draft pull request";
    case "bot-author":
      return "Opened by a bot";
    case "repo-not-active":
      return "Repository not added yet";
    case "auto-review-off":
      return "Automatic review is off";
    case "no-knowledge-yet":
      return "Knowledge not built yet";
    case "diff-too-large":
      return "Diff too large";
    case "no-code-changes":
      return "No code changes";
    default:
      return reason ?? "Skipped";
  }
}

export function jobLabel(job: JobRow): string {
  if (job.type === "init") return "Set up repository";
  if (job.type === "remake") return "Synced knowledge";
  if (job.type === "review") {
    return job.pr_number ? `Review #${job.pr_number}` : "Review";
  }
  return job.type;
}

/** The job page title, "Init · widgets": the kind of job, then the
 * repository's short name. */
function jobTitle(job: JobRow): string {
  const kind =
    job.type === "init"
      ? "Init"
      : job.type === "remake"
        ? "Sync"
        : job.type === "review"
          ? job.pr_number
            ? `Review #${job.pr_number}`
            : "Review"
          : job.type;
  return `${kind} · ${job.repo.split("/").pop() ?? job.repo}`;
}

function cancelReasonLabel(reason: string | null): string {
  switch (reason) {
    case "dashboard_canceled":
      return "Canceled from the dashboard";
    case "superseded":
      return "Replaced by a newer job";
    case "client_timeout":
      return "No sync from the CLI";
    case "client_canceled":
      return "Canceled from the CLI";
    case "token_deactivated":
      return "Token was deactivated";
    case "token_deleted":
      return "Token was deleted";
    case "repo_deactivated":
      return "Repository was removed from the dashboard";
    case "server_restarted":
      return "Server restarted during the job";
    default:
      return reason ?? "Canceled";
  }
}

function jobStatus(job: JobRow): string {
  if (job.status === "done") return `<span class="st ok">Done</span>`;
  if (job.status === "failed") {
    return `<a class="st err" href="/activity/${text(job.id)}">Failed</a>`;
  }
  if (job.status === "canceled") {
    const detail = job.cancel_reason
      ? ` title="${text(cancelReasonLabel(job.cancel_reason))}"`
      : "";
    return `<span class="st warn"${detail}>Canceled</span>`;
  }
  if (job.status === "queued") return `<span class="st run">Queued</span>`;
  return `<span class="st run">${text(job.status)}</span>`;
}

function logBlock(logs: JobLogRow[], emptyText: string): string {
  return `<div class="log">${
    logs
      .map(
        (line) =>
          `<span class="t">${when(line.at)}</span>  ${text(line.message)}`,
      )
      .join("\n") || text(emptyText)
  }</div>`;
}

function parseJobArgs(job: JobRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(job.args || "{}");
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

type Stage = {
  name: string;
  state: string;
  detail?: string;
  percent?: number;
};

function stagesOf(args: Record<string, unknown>): Stage[] {
  return asArray(args.stages).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const name = asString(row.name);
    if (!name) return [];
    return [
      {
        name,
        state: asString(row.state) ?? "pending",
        detail: asString(row.detail),
        percent: asNumber(row.percent),
      },
    ];
  });
}

function estimateSeconds(args: Record<string, unknown>): number[] {
  const direct = asArray(args.estimateSeconds)
    .map(asNumber)
    .filter((n): n is number => n !== undefined);
  if (direct.length) return direct;
  const estimate = args.estimate;
  if (!estimate || typeof estimate !== "object") return [];
  return asArray((estimate as Record<string, unknown>).seconds)
    .map(asNumber)
    .filter((n): n is number => n !== undefined);
}

function estimateUsd(args: Record<string, unknown>): number[] {
  const estimate = args.estimate;
  if (!estimate || typeof estimate !== "object") return [];
  return asArray((estimate as Record<string, unknown>).usd)
    .map(asNumber)
    .filter((n): n is number => n !== undefined);
}

function runningEstimateUsd(args: Record<string, unknown>): number | undefined {
  return asNumber(args.estimate);
}

function jobDurationMs(
  job: JobRow,
  args: Record<string, unknown>,
  review: ReviewRow | undefined,
): number | undefined {
  const fromArgs = asNumber(args.durationMs);
  if (fromArgs !== undefined) return fromArgs;
  if (review && review.duration_ms !== null && review.duration_ms !== undefined) {
    return review.duration_ms;
  }
  if (job.started_at && job.finished_at) {
    const start = Date.parse(job.started_at);
    const end = Date.parse(job.finished_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return end - start;
    }
  }
  return undefined;
}

function jobCost(
  args: Record<string, unknown>,
  review: ReviewRow | undefined,
): number | undefined {
  const fromArgs = asNumber(args.cost);
  if (fromArgs !== undefined) return fromArgs;
  if (
    review &&
    (review.cost_status === "known" ||
      (review.cost_status === null && review.cost !== null))
  ) {
    return review.cost ?? undefined;
  }
  return undefined;
}

function jobDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "n/a";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest}s`;
}

function minutesRange(values: number[]): string {
  if (!values.length) return "";
  const minutes = values.map((value) => Math.round(value / 60));
  const low = Math.min(...minutes);
  const high = Math.max(...minutes);
  return low === high ? `${low} min` : `${low} to ${high} min`;
}

function moneyRange(values: number[]): string {
  if (!values.length) return "";
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? money(low) : `${money(low)} to ${money(high)}`;
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toTimeString().slice(0, 8);
}

function logLevel(level: string): string {
  return ["info", "dim", "ok", "warn", "error"].includes(level)
    ? level
    : "info";
}

function logLines(logs: JobLogRow[]): string {
  return logs
    .map(
      (line) =>
        `<div class="line lv-${logLevel(line.level)}" data-seq="${line.seq}"><span class="t">${clock(line.at)}</span><span class="msg">${text(line.message)}</span></div>`,
    )
    .join("");
}

function logPanel(
  job: JobRow,
  logs: JobLogRow[],
  live: boolean,
  status: string,
  kind: string,
): string {
  const count = `${logs.length} line${logs.length === 1 ? "" : "s"}`;
  const lastSeq = logs.length ? logs[logs.length - 1]!.seq : 0;
  const emptyLog =
    logs.length === 0
      ? `<p class="log-empty">No log lines yet. New lines appear here as the job runs.</p>`
      : "";
  return `<div class="logpanel" data-log="${text(job.id)}" data-job="${text(job.id)}" data-live="${live ? "1" : "0"}" data-status="${text(status)}" data-seq="${lastSeq}">
    <div class="lhd"><span class="st ${kind}">${text(status)}</span><h3>Log</h3><span class="cnt" role="status" aria-live="polite">${count}</span><button class="btn out" type="button" data-log-pause>Pause</button><button class="btn out" type="button" data-log-clear>Clear</button></div>
    <div class="logerr" data-log-error hidden></div>
    <div class="logwrap"><div class="log" tabindex="0" role="log" aria-live="off">${logLines(logs)}${emptyLog}</div><button class="jump" type="button" data-log-jump hidden>Jump to latest <span></span></button></div>
  </div>`;
}

function stagesBlock(stages: Stage[]): string {
  if (!stages.length) return "";
  const rows = stages
    .map((stage) => {
      const state = ["done", "current", "pending", "skipped"].includes(
        stage.state,
      )
        ? stage.state
        : "pending";
      const tone =
        state === "done" ? "b-em" : state === "current" ? "b-sky" : "";
      const mark =
        state === "done"
          ? icon("check")
          : state === "current"
            ? icon("loader", "spin")
            : icon("circle");
      const percent =
        stage.percent === undefined
          ? ""
          : `<div class="prog" style="margin-top:6px"><i style="width:${Math.max(
              0,
              Math.min(100, stage.percent),
            )}%"></i></div>`;
      const detail = stage.detail
        ? `<div class="muted" style="font-size:13px">${text(stage.detail)}</div>`
        : "";
      return `<li data-stage-state="${state}"><span class="ic ${tone}">${mark}</span><div style="flex:1;min-width:0"><div class="${
        state === "pending" ? "muted" : "strong"
      }">${text(stage.name)}</div>${detail}${percent}</div></li>`;
    })
    .join("");
  return `<ul class="timeline">${rows}</ul>`;
}

function runningBody(
  job: JobRow,
  args: Record<string, unknown>,
  logs: JobLogRow[],
): string {
  const spent = asNumber(args.spent);
  const estimate = runningEstimateUsd(args);
  const seconds = estimateSeconds(args);
  const spentText =
    spent === undefined
      ? ""
      : `${money(spent)}${estimate === undefined ? "" : ` of ~${money(estimate)}`}`;
  const details = [
    spentText
      ? `<div><dt>Spent so far</dt><dd class="tnum">${spentText}</dd></div>`
      : "",
    seconds.length
      ? `<div><dt>Estimated time</dt><dd>${minutesRange(seconds)} left</dd></div>`
      : "",
  ].join("");
  return `<div class="card"><div class="bd">
    <div class="notice bad" data-job-refresh-error hidden></div>
    <div data-job-progress>
      ${stagesBlock(stagesOf(args))}
      ${details ? `<dl class="dl" style="margin-top:8px">${details}</dl>` : ""}
    </div>
    ${logPanel(job, logs, true, "Running", "run")}
  </div></div>`;
}

function producedOf(
  args: Record<string, unknown>,
  job: JobRow,
  review: ReviewRow | undefined,
): { label: string; detail: string } {
  const raw = args.produced;
  if (raw && typeof raw === "object") {
    const row = raw as Record<string, unknown>;
    const label = asString(row.label);
    const detail = asString(row.detail);
    if (label || detail) {
      return { label: label ?? "Done", detail: detail ?? "" };
    }
  }
  if (review) {
    const count = review.findings_count;
    return {
      label: `${count} finding${count === 1 ? "" : "s"}`,
      detail: `from the review of ${job.repo}#${job.pr_number ?? ""}`,
    };
  }
  if (job.type === "init" || job.type === "remake") {
    return {
      label: "No guide yet",
      detail:
        "There is not enough review history to learn from yet. Once this repository has a few reviewed pull requests, run the sync again.",
    };
  }
  return {
    label: "Knowledge updated",
    detail: `from ${job.repo}`,
  };
}

function defaultNextAction(job: JobRow, appConfigured: boolean): string {
  if (job.type === "review") {
    return "Open the pull request to read the review.";
  }
  if (job.type === "init" || job.type === "remake") {
    return appConfigured
      ? "Open a pull request on the repository. It will be reviewed automatically."
      : "Open a pull request on the repository. Connect the GitHub App first so pull requests get reviewed.";
  }
  return "Open the repository to see what changed.";
}

function doneBody(
  job: JobRow,
  args: Record<string, unknown>,
  logs: JobLogRow[],
  review: ReviewRow | undefined,
): string {
  const config = readConfig();
  const appConfigured = Boolean(
    config.githubAppId && resolveAppPrivateKey(config),
  );
  const produced = producedOf(args, job, review);
  const durationMs = jobDurationMs(job, args, review);
  const cost = jobCost(args, review);
  const seconds = estimateSeconds(args);
  const usd = estimateUsd(args);
  const tookDetail = seconds.length
    ? `estimate was ${minutesRange(seconds)}`
    : "";
  const costDetail = usd.length ? `estimate was ${moneyRange(usd)}` : "";
  const providedNext = asString(args.nextAction);
  const promisedAutomatic =
    providedNext !== undefined &&
    /reviewed automatically|review automatically|will be reviewed/i.test(
      providedNext,
    );
  const next =
    !appConfigured && promisedAutomatic
      ? defaultNextAction(job, false)
      : providedNext ?? defaultNextAction(job, appConfigured);
  const appLink =
    !appConfigured && (job.type === "init" || job.type === "remake")
      ? `<a class="btn out" href="/settings/github">Connect the GitHub App</a>`
      : "";
  return `<div class="stats three">
    <div class="stat"><div class="top">Learned</div><div class="v">${text(
      produced.label,
    )}</div><div class="h">${text(produced.detail)}</div></div>
    <div class="stat"><div class="top">Took</div><div class="v tnum">${jobDuration(
      durationMs,
    )}</div><div class="h">${text(tookDetail)}</div></div>
    <div class="stat"><div class="top">Cost</div><div class="v tnum">${
      cost === undefined ? "unknown" : money(cost)
    }</div><div class="h">${text(costDetail)}</div></div>
  </div>
  <div class="card"><div class="bd">
    <h2>Next</h2>
    <p>${text(next)}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <a class="btn primary" href="/repos/${text(
        job.repo,
      )}/knowledge">See the guides</a>
      <a class="btn out" href="/repos/${text(job.repo)}/pulls">Review an open PR</a>
      ${appLink}
    </div>
    ${logPanel(job, logs, false, "Done", "done")}
  </div></div>`;
}

function noteStatus(review: ReviewRow | undefined): string {
  if (!review) return "";
  return review.note_comment_id
    ? "a note was left on the pull request"
    : "could not post a note on the pull request";
}

function failureExplanation(error: string | null | undefined): string {
  const value = (error ?? "").toLowerCase();
  if (/empty (answer|review)|returned an empty/.test(value)) {
    return "The model returned an empty answer, so no review was written.";
  }
  if (/\b403\b|resource not accessible|access denied|forbidden/.test(value)) {
    return "GitHub denied the request with a 403. The GitHub App may be missing a permission.";
  }
  if (/\b429\b|too many requests|rate limit/.test(value)) {
    return "GitHub rate limit reached with a 429. Wait a moment and retry.";
  }
  if (/timed out|timeout/.test(value)) {
    return "The request timed out. The provider did not answer in time.";
  }
  return "";
}

function failedBody(
  job: JobRow,
  args: Record<string, unknown>,
  logs: JobLogRow[],
  review: ReviewRow | undefined,
): string {
  const provider = asString(args.provider);
  const model = asString(args.model);
  const note = noteStatus(review);
  const durationMs = jobDurationMs(job, args, review);
  const cost = jobCost(args, review);
  const explanation = failureExplanation(job.error);
  const rows = [
    provider
      ? `<div><dt>Provider</dt><dd>${text(provider)}</dd></div>`
      : "",
    model
      ? `<div><dt>Model</dt><dd class="mono">${text(model)}</dd></div>`
      : "",
    note ? `<div><dt>Pull request note</dt><dd>${text(note)}</dd></div>` : "",
    durationMs !== undefined
      ? `<div><dt>Duration</dt><dd class="tnum">${jobDuration(
          durationMs,
        )}</dd></div>`
      : "",
    cost !== undefined
      ? `<div><dt>Cost</dt><dd class="tnum">${money(cost)}</dd></div>`
      : "",
  ].join("");
  return `<div class="card"><div class="bd">
    ${rows ? `<dl class="dl">${rows}</dl>` : ""}
    ${
      explanation
        ? `<div class="notice bad"><div class="txt">${text(explanation)}</div></div>`
        : ""
    }
    ${logPanel(job, logs, false, "Failed", "failed")}
  </div></div>`;
}

function otherBody(job: JobRow, logs: JobLogRow[]): string {
  const status =
    job.status === "canceled"
      ? "Canceled"
      : job.status === "queued"
        ? "Queued"
        : job.status;
  const kind = job.status === "canceled" ? "warn" : "run";
  return `<div class="card"><div class="bd">${logPanel(
    job,
    logs,
    false,
    status,
    kind,
  )}</div></div>`;
}

function liveCard(job: JobRow): string {
  const logs = getLogsSince(job.id).slice(-24);
  return `<div class="card" data-async>
    ${skSlot()}
    <div class="hd">
      <span class="st run">${text(job.status === "queued" ? "Queued" : "Running")}</span>
      <h2><a href="/activity/${text(job.id)}">${text(jobLabel(job))} ${text(job.repo)}</a></h2>
      <span class="muted" style="margin-left:auto;font-size:13px">${when(
        job.started_at ?? job.created_at,
      )}</span>
      <button class="btn sm" data-cancel="${text(job.id)}">Stop</button>
    </div>
    <div class="bd">${logBlock(logs, "Waiting for log lines.")}</div>
  </div>`;
}

export function renderActivity(
  username: string,
  running: ReturnType<typeof runningJobs>,
  feed: ReturnType<typeof activityFeed>,
  skipped: ReturnType<typeof skippedDeliveries>,
): Response {
  const live = running.map(liveCard).join("");
  const start = (feed.page - 1) * feed.per + 1;
  const end = Math.min(feed.page * feed.per, feed.total);
  const rows = feed.items
    .map((item) => {
      if (item.kind === "review") {
        const review = item.review;
        const result =
          review.status === "failed"
            ? `<span class="st err">Failed</span>`
            : review.status === "access_denied"
              ? `<span class="st err">Access denied</span>`
              : `<span class="st ok">${review.findings_count} finding${
                  review.findings_count === 1 ? "" : "s"
                }</span>`;
        return `<tr><td>Reviewed pull request</td>
          <td><a href="/repos/${text(review.repo)}/pulls/${review.pr_number}">${text(
            review.repo,
          )} #${review.pr_number}</a></td>
          <td class="muted">${when(review.created_at)}</td>
          <td>${result}</td>
          <td class="num">${formatCost(review)}</td></tr>`;
      }
      const job = item.job;
      return `<tr><td><a href="/activity/${text(job.id)}">${text(jobLabel(job))}</a></td>
          <td><a href="/repos/${text(job.repo)}">${text(job.repo)}</a></td>
          <td class="muted">${when(job.created_at)}</td>
          <td>${jobStatus(job)}</td>
          <td class="num"></td></tr>`;
    })
    .join("");
  const recent =
    feed.items.length === 0
      ? empty("Nothing yet", "Jobs and reviews will show up here.")
      : `<table>
        <thead><tr><th>What</th><th>Repository</th><th>When</th><th>Result</th><th class="num">Cost</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="pager"><span>${
        feed.total === 0 ? "0 of 0" : `${start}-${end} of ${feed.total}`
      }</span><span class="sp"></span>
        ${
          feed.page > 1
            ? `<a class="btn sm" href="?page=${feed.page - 1}">Previous</a>`
            : `<button class="btn sm" disabled>Previous</button>`
        }
        ${
          end < feed.total
            ? `<a class="btn sm" href="?page=${feed.page + 1}">Next</a>`
            : `<button class="btn sm" disabled>Next</button>`
        }</div>`;
  const skippedRows = skipped
    .slice(0, 20)
    .map((row) => {
      const label = `${row.repo ?? ""}${row.pr_number ? ` #${row.pr_number}` : ""}`;
      // A pull request waiting for a request is one click from a review, and
      // the person on the dashboard is already allowed to ask.
      const action =
        row.repo && row.pr_number && isWaitingForRequest(row.reason)
          ? `<button class="btn sm" type="button" data-post="/api/repos/${text(row.repo)}/pulls/${row.pr_number}/review" aria-label="Review ${text(label)} now">Review now</button>`
          : "";
      return `<tr><td>${text(label)}</td>
        <td class="muted">${text(skipReason(row.reason))}</td>
        <td class="muted" style="width:120px">${when(row.received_at)}</td>
        <td style="width:110px;text-align:right">${action}</td></tr>`;
    })
    .join("");
  return html(
    layout({
      title: "Activity · co-maintainer",
      username,
      active: "/activity",
      body: `<div class="wrap" id="activity-root">
  <div class="pagehead">
    <div><h1>Activity</h1>
      <p class="lead">What is running now and what happened recently.</p></div>
  </div>
  ${live}
  <div class="card">
    <div class="hd"><h2>Recent</h2></div>
    <div class="bd flush">${recent}</div>
  </div>
  <div class="card">
    <div class="hd"><h2>Pull requests we skipped</h2>
      <span class="muted" style="margin-left:auto;font-size:13px">Why nothing happened</span></div>
    <div class="bd flush">${
      skippedRows
        ? `<table><tbody>${skippedRows}</tbody></table>`
        : empty(
            "No skips recorded",
            "Skipped pull request deliveries appear here.",
          )
    }</div>
  </div>
</div>`,
    }),
  );
}

export function renderJob(
  username: string,
  job: JobRow,
  logs: JobLogRow[],
): Response {
  const args = parseJobArgs(job);
  const review = getReviewByJobId(job.id);
  const waits = listRateLimitWaits(job.id);
  const waitSummary = summarizeRateLimitWaits(waits);
  const waitNotice = rateLimitWaitNotice(
    waits,
    waitSummary,
    "Rate-limit waits",
  );
  const waitDetails = rateLimitWaitDetails(waits);
  const live = job.status === "queued" || job.status === "running";
  const failed = job.status === "failed";
  const error = job.error
    ? `<div class="notice bad"><div class="txt">${text(job.error)}</div></div>`
    : "";
  const canceled =
    job.status === "canceled" && job.cancel_reason
      ? `<div class="notice warn"><div class="txt">${text(
          cancelReasonLabel(job.cancel_reason),
        )}</div></div>`
      : "";
  const stop = live
    ? `<button class="btn out" type="button" data-cancel="${text(job.id)}">${icon(
        "square",
      )}Stop after this step</button>`
    : "";
  const left = live ? minutesRange(estimateSeconds(args)) : "";
  const lead = live
    ? `Started ${when(job.started_at ?? job.created_at)}${left ? ` · about ${left} left` : ""}`
    : `<a href="/repos/${text(job.repo)}">${text(job.repo)}</a> · ${text(job.status)}`;
  let retry = "";
  if (failed && (job.type === "init" || job.type === "remake")) {
    retry = `<button class="primary" type="button" data-post="/api/repos/${text(
      job.repo,
    )}/remake">Retry</button>`;
  } else if (failed && job.type === "review" && job.pr_number) {
    retry = `<button class="primary" type="button" data-post="/api/repos/${text(
      job.repo,
    )}/pulls/${job.pr_number}/review">Retry with the same model</button>`;
  }
  const changeModel = failed
    ? `<a class="btn out" href="/settings/ai">Change default model</a>`
    : "";
  let body: string;
  if (live) {
    body = runningBody(job, args, logs);
  } else if (job.status === "done") {
    body = doneBody(job, args, logs, review);
  } else if (failed) {
    body = failedBody(job, args, logs, review);
  } else {
    body = otherBody(job, logs);
  }
  return html(
    layout({
      title: `${jobLabel(job)} · co-maintainer`,
      username,
      active: "/activity",
      body: `<div class="wrap narrow" id="activity-root">
  ${pageHeader({
    title: jobTitle(job),
    leadHtml: lead,
    crumb: crumb([{ label: "Activity", href: "/activity" }, { label: jobLabel(job) }]),
    actions: `${stop}${retry}${changeModel}`,
  })}
  ${error}${canceled}
  <div data-async>
    ${skSlot()}
    ${waitNotice}
    ${body}
    ${waitDetails}
  </div>
</div>`,
    }),
  );
}
