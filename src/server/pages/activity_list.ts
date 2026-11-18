/** The Activity page: what runs now, every job and review that ran, and
 * what was skipped. A review is one row, the job that ran it and the result
 * it wrote together. */
import {
  empty,
  escapeHtml,
  html,
  layout,
  plural,
  text,
  when,
} from "./layout.ts";
import { formatCost } from "./cost.ts";
import { icon, segmented } from "./ui.ts";
import {
  failureExplanation,
  isWaitingForRequest,
  jobStatus,
  liveCard,
  parseJobArgs,
  reviewResultHref,
} from "./activity.ts";
import {
  ACTIVITY_KINDS,
  cancelReasonText,
  jobDetailText,
  jobKindText,
  reasonText,
} from "./activity_words.ts";
import {
  type ActivityQuery,
  activityHref,
  isFiltered,
} from "./activity_query.ts";
import type {
  activityFeed,
  runningJobs,
  skippedDeliveries,
} from "../../services/dashboard.ts";
import type { ActivityRow } from "../../store/activity.ts";
import type { ReviewRow } from "../../store/rows.ts";

/** The label of a review row whose job row is gone. */
function reviewKindText(review: ReviewRow): string {
  if (review.kind === "push") return jobKindText({ type: "push_review" });
  if (review.kind === "remote") return jobKindText({ type: "remote_review" });
  return jobKindText({ type: "review" });
}

/** The first line of an error, short enough for a table cell. */
function shortError(error: string | null | undefined): string {
  const line = (error ?? "")
    .split("\n")[0]!
    .replace(/^Error:\s*/, "")
    .trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** Why a row failed, in a sentence. */
export function failedReason(row: ActivityRow): string {
  const error = row.job?.error ?? null;
  return (
    failureExplanation(error) ||
    shortError(error) ||
    (row.review?.status === "access_denied"
      ? "GitHub denied access to the pull request."
      : "The review failed.")
  );
}

function resultCell(row: ActivityRow): string {
  const { job, review } = row;
  if (row.state === "running") {
    return `<span class="muted">${job?.status === "queued" ? "Waiting for a worker" : "In progress"}</span>`;
  }
  if (row.state === "failed") {
    return `<span class="muted">${text(failedReason(row))}</span>`;
  }
  if (row.state === "canceled") {
    return `<span class="muted">${text(cancelReasonText(job?.cancel_reason))}</span>`;
  }
  if (review) {
    if (review.status === "not_posted") {
      return `<span class="st warn">Not posted</span>`;
    }
    return `<a class="st ok" href="${escapeHtml(
      reviewResultHref(review),
    )}">${plural(review.findings_count, "finding")}</a>`;
  }
  if (job) {
    const detail = jobDetailText(job);
    if (detail) return `<span class="muted">${text(detail)}</span>`;
    const produced = parseJobArgs(job).produced as
      | { label?: unknown }
      | undefined;
    if (produced && typeof produced.label === "string") {
      return `<span class="muted">${text(produced.label)}</span>`;
    }
  }
  return "";
}

function statusCell(row: ActivityRow): string {
  if (row.job) {
    if (row.state === "skipped") return `<span class="st ok">Skipped</span>`;
    if (row.state === "failed" && row.job.status !== "failed") {
      return `<a class="st err" href="/activity/${text(row.job.id)}">Failed</a>`;
    }
    return jobStatus(row.job);
  }
  if (row.state === "failed") return `<span class="st err">Failed</span>`;
  if (row.state === "canceled") return `<span class="st warn">Canceled</span>`;
  return `<span class="st ok">Done</span>`;
}

function subjectCell(row: ActivityRow): string {
  const repo = row.job?.repo ?? row.review?.repo ?? "";
  const pr = row.job?.pr_number ?? row.review?.pr_number ?? null;
  const repoLink = `<a href="/repos/${text(repo)}">${text(repo)}</a>`;
  if (!pr) return repoLink;
  return `${repoLink} <a href="/repos/${text(repo)}/pulls/${pr}">#${pr}</a>${
    row.title ? `<span class="sub">${text(row.title)}</span>` : ""
  }`;
}

function activityRow(row: ActivityRow): string {
  const { job, review } = row;
  // Every row opens its log. A review whose job row is gone has no log left,
  // so it opens its result.
  const href = job
    ? `/activity/${job.id}`
    : review
      ? reviewResultHref(review)
      : "/activity";
  const label = job ? jobKindText(job) : review ? reviewKindText(review) : "";
  return `<tr data-href="${escapeHtml(href)}">
    <td class="wrap"><a class="strong" href="${escapeHtml(href)}">${text(label)}</a></td>
    <td class="wrap">${subjectCell(row)}</td>
    <td class="wrap">${resultCell(row)}</td>
    <td class="num">${review ? formatCost(review) : ""}</td>
    <td class="muted">${when(row.at)}</td>
    <td>${statusCell(row)}</td>
  </tr>`;
}

function pager(feed: ReturnType<typeof activityFeed>, query: ActivityQuery) {
  const start = (feed.page - 1) * feed.per + 1;
  const end = Math.min(feed.page * feed.per, feed.total);
  return `<div class="pager"><span>${
    feed.total === 0 ? "0 of 0" : `${start}-${end} of ${feed.total}`
  }</span><span class="sp"></span>
    ${
      feed.page > 1
        ? `<a class="btn sm" href="${escapeHtml(activityHref(query, { page: feed.page - 1 }))}">Previous</a>`
        : `<button class="btn sm" disabled>Previous</button>`
    }
    ${
      end < feed.total
        ? `<a class="btn sm" href="${escapeHtml(activityHref(query, { page: feed.page + 1 }))}">Next</a>`
        : `<button class="btn sm" disabled>Next</button>`
    }</div>`;
}

function skippedCard(skipped: ReturnType<typeof skippedDeliveries>): string {
  const rows = skipped
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
        <td class="muted">${text(reasonText(row.reason, row.outcome))}</td>
        <td class="muted" style="width:120px">${when(row.received_at)}</td>
        <td style="width:110px;text-align:right">${action}</td></tr>`;
    })
    .join("");
  return `<div class="card">
    <div class="hd"><h2>Pull requests we skipped</h2>
      <span class="muted" style="margin-left:auto;font-size:13px">Why nothing happened</span></div>
    <div class="bd flush">${
      rows
        ? `<table><tbody>${rows}</tbody></table>`
        : empty(
            "No skips recorded",
            "Skipped pull request deliveries appear here.",
          )
    }</div>
  </div>`;
}

const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
  skipped: "Skipped",
};

/** The search box, the repository, PR and date fields, the status and kind
 * chips, and one chip per active value that takes it off again. */
function filtersBlock(query: ActivityQuery, repos: string[]): string {
  const statusChips = segmented([
    {
      label: "All",
      href: activityHref(query, { status: undefined }),
      on: !query.status,
    },
    ...Object.entries(STATUS_LABELS).map(([status, label]) => ({
      label,
      href: activityHref(query, { status }),
      on: query.status === status,
    })),
  ]);
  const kindChips = segmented([
    {
      label: "Every kind",
      href: activityHref(query, { kind: undefined }),
      on: !query.kind,
    },
    ...ACTIVITY_KINDS.map((kind) => ({
      label: kind.label,
      href: activityHref(query, { kind: kind.id }),
      on: query.kind === kind.id,
    })),
  ]);
  const choices = [...new Set([...repos, ...(query.repo ? [query.repo] : [])])];
  const repoSelect = `<select class="inp" name="repo" aria-label="Repository" style="width:auto">
      <option value="">All repositories</option>
      ${choices
        .map(
          (name) =>
            `<option value="${escapeHtml(name)}"${
              name === query.repo ? " selected" : ""
            }>${text(name)}</option>`,
        )
        .join("")}
    </select>`;
  const hidden = (["status", "kind"] as const)
    .map((name) =>
      query[name]
        ? `<input type="hidden" name="${name}" value="${escapeHtml(query[name])}">`
        : "",
    )
    .join("");
  const active: { label: string; drop: keyof ActivityQuery }[] = [];
  if (query.repo) active.push({ label: query.repo, drop: "repo" });
  if (query.pr) active.push({ label: `PR #${query.pr}`, drop: "pr" });
  if (query.from) active.push({ label: `From ${query.from}`, drop: "from" });
  if (query.to) active.push({ label: `To ${query.to}`, drop: "to" });
  if (query.q) active.push({ label: `Search: ${query.q}`, drop: "q" });
  const chips = active.length
    ? `<div class="chips">${active
        .map(
          (chip) =>
            `<a class="chip" href="${escapeHtml(
              activityHref(query, { [chip.drop]: undefined }),
            )}" aria-label="${escapeHtml(`Remove ${chip.label}`)}">${text(
              chip.label,
            )}${icon("circle-x")}</a>`,
        )
        .join("")}</div>`
    : "";
  return `<form class="filters" method="get" action="/activity" role="search" id="activity-filters">
    <div class="sbox">${icon("search")}<input class="inp" type="search" name="q" value="${escapeHtml(
      query.q ?? "",
    )}" placeholder="Search repository, title, error" aria-label="Search repository, pull request title and error" data-kb-search></div>
    ${repoSelect}
    <input class="inp" type="number" min="1" step="1" name="pr" value="${
      query.pr ?? ""
    }" placeholder="PR" aria-label="Pull request number" style="width:90px">
    <input class="inp" type="date" name="from" value="${escapeHtml(query.from ?? "")}" aria-label="From day" style="width:auto">
    <input class="inp" type="date" name="to" value="${escapeHtml(query.to ?? "")}" aria-label="To day" style="width:auto">
    ${hidden}
    <button type="submit" class="btn out sm">Filter</button>
  </form>
  <div class="filters">${statusChips}</div>
  <div class="filters">${kindChips}</div>
  ${chips}`;
}

export function renderActivity(
  username: string,
  running: ReturnType<typeof runningJobs>,
  feed: ReturnType<typeof activityFeed>,
  skipped: ReturnType<typeof skippedDeliveries>,
  query: ActivityQuery = { page: 1 },
  repos: string[] = [],
): Response {
  const filtered = isFiltered(query);
  const live = running.map(liveCard).join("");
  const recent =
    feed.items.length === 0
      ? filtered
        ? empty(
            "Nothing matches",
            "No job or review fits this filter.",
            `<a class="btn out sm" href="/activity">Show all</a>`,
          )
        : empty("Nothing yet", "Jobs and reviews will show up here.")
      : `<table class="fit">
        <thead><tr><th>What</th><th>Repository</th><th>Result</th><th class="num">Cost</th><th>When</th><th>Status</th></tr></thead>
        <tbody>${feed.items.map(activityRow).join("")}</tbody>
      </table>
      ${pager(feed, query)}`;
  const filterNotice = filtered
    ? `<div class="notice info"><div class="txt">Showing ${plural(
        feed.total,
        query.status === "failed" ? "failure" : "row",
      )} that ${feed.total === 1 ? "fits" : "fit"} this filter.</div><a class="btn out sm" href="/activity">Show all</a></div>`
    : "";
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
  ${filtersBlock(query, repos)}
  ${filterNotice}
  <div class="card">
    <div class="hd"><h2>Recent</h2></div>
    <div class="bd flush">${recent}</div>
  </div>
  ${skippedCard(skipped)}
</div>
<script>
document.addEventListener("click", function(event) {
  const row = event.target.closest("#activity-root tr[data-href]");
  if (!row || event.target.closest("a, button, input, label")) return;
  location.href = row.getAttribute("data-href");
});
</script>`,
    }),
  );
}
