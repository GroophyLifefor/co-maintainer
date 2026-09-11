import { empty, html, layout, money, skSlot, text, when } from "./layout.ts";
import type {
  activityFeed,
  runningJobs,
  skippedDeliveries,
} from "../../services/dashboard.ts";
import { getLogsSince } from "../../services/jobs.ts";
import type { JobLogRow, JobRow } from "../../store/rows.ts";

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

function jobLabel(job: JobRow): string {
  if (job.type === "init") return "Set up repository";
  if (job.type === "remake") return "Updated knowledge";
  if (job.type === "review") {
    return job.pr_number ? `Review #${job.pr_number}` : "Review";
  }
  return job.type;
}

function jobStatus(job: JobRow): string {
  if (job.status === "done") return `<span class="st ok">Done</span>`;
  if (job.status === "failed") {
    return `<a class="st err" href="/activity/${text(job.id)}">Failed</a>`;
  }
  if (job.status === "canceled") return `<span class="st warn">Canceled</span>`;
  if (job.status === "queued") return `<span class="st run">Queued</span>`;
  return `<span class="st run">${text(job.status)}</span>`;
}

function logBlock(logs: JobLogRow[], emptyText: string): string {
  return `<div class="log">${
    logs.map((line) =>
      `<span class="t">${when(line.at)}</span>  ${text(line.message)}`
    ).join("\n") || text(emptyText)
  }</div>`;
}

function liveCard(job: JobRow): string {
  const logs = getLogsSince(job.id).slice(-24);
  return `<div class="card" data-async>
    ${skSlot()}
    <div class="hd">
      <span class="st run">${
    text(job.status === "queued" ? "Queued" : "Running")
  }</span>
      <h2><a href="/activity/${text(job.id)}">${text(jobLabel(job))} ${
    text(job.repo)
  }</a></h2>
      <span class="muted" style="margin-left:auto;font-size:13px">${
    when(job.started_at ?? job.created_at)
  }</span>
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
  const rows = feed.items.map((item) => {
    if (item.kind === "review") {
      const review = item.review;
      const result = review.status === "failed"
        ? `<span class="st err">Failed</span>`
        : review.status === "access_denied"
        ? `<span class="st err">Access denied</span>`
        : `<span class="st ok">${review.findings_count} finding${
          review.findings_count === 1 ? "" : "s"
        }</span>`;
      return `<tr><td>Reviewed pull request</td>
          <td><a href="/repos/${text(review.repo)}/pulls/${review.pr_number}">${
        text(review.repo)
      } #${review.pr_number}</a></td>
          <td class="muted">${when(review.created_at)}</td>
          <td>${result}</td>
          <td class="num">${money(Number(review.cost ?? 0))}</td></tr>`;
    }
    const job = item.job;
    return `<tr><td><a href="/activity/${text(job.id)}">${
      text(jobLabel(job))
    }</a></td>
          <td><a href="/repos/${text(job.repo)}">${text(job.repo)}</a></td>
          <td class="muted">${when(job.created_at)}</td>
          <td>${jobStatus(job)}</td>
          <td class="num"></td></tr>`;
  }).join("");
  const recent = feed.items.length === 0
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
  const skippedRows = skipped.slice(0, 20).map((row) =>
    `<tr><td>${text(row.repo ?? "")}${
      row.pr_number ? ` #${row.pr_number}` : ""
    }</td>
        <td class="muted">${text(skipReason(row.reason))}</td>
        <td class="muted" style="width:120px">${
      when(row.received_at)
    }</td></tr>`
  ).join("");
  return html(layout({
    title: "Activity · co-maintainer",
    username,
    active: "activity",
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
      skippedRows ? `<table><tbody>${skippedRows}</tbody></table>` : empty(
        "No skips recorded",
        "Skipped pull request deliveries appear here.",
      )
    }</div>
  </div>
</div>`,
  }));
}

export function renderJob(
  username: string,
  job: JobRow,
  logs: JobLogRow[],
): Response {
  const live = job.status === "queued" || job.status === "running";
  const failed = job.status === "failed";
  const error = job.error
    ? `<div class="notice bad"><div class="txt">${text(job.error)}</div></div>`
    : "";
  const stop = live
    ? `<button class="btn sm" data-cancel="${text(job.id)}">Stop</button>`
    : "";
  let retry = "";
  if (failed && (job.type === "init" || job.type === "remake")) {
    retry = `<button class="primary" data-post="/api/repos/${
      text(job.repo)
    }/remake">Retry</button>`;
  } else if (failed && job.type === "review" && job.pr_number) {
    retry = `<button class="primary" data-post="/api/repos/${
      text(job.repo)
    }/pulls/${job.pr_number}/review">Retry</button>`;
  }
  return html(layout({
    title: `${jobLabel(job)} · co-maintainer`,
    username,
    active: "activity",
    body: `<div class="wrap" id="activity-root" style="max-width:760px">
  <div class="crumbs"><a href="/activity">Activity</a> / ${
      text(jobLabel(job))
    }</div>
  <div class="pagehead">
    <div>
      <h1>${text(jobLabel(job))}</h1>
      <p class="lead"><a href="/repos/${text(job.repo)}">${
      text(job.repo)
    }</a> · ${text(job.status)}</p>
    </div>
    <div class="actions">${stop}${retry}</div>
  </div>
  ${error}
  <div class="card" data-async>
    ${skSlot()}
    <div class="hd"><h2>Log</h2>
      <span class="muted" style="margin-left:auto;font-size:13px">${logs.length} lines</span></div>
    <div class="bd">${logBlock(logs, "No log lines were written.")}</div>
  </div>
</div>`,
  }));
}
