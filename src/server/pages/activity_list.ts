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
import { badge, icon, segmented } from "./ui.ts";
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
import {
  type RetryTarget,
  retryTarget,
} from "../../services/activity_actions.ts";
import type { DeliveryRow, ReviewRow } from "../../store/rows.ts";

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

/** The request a Retry button sends, the same one the job page sends. */
function retryRequest(target: RetryTarget): {
  url: string;
  body: Record<string, string>;
} {
  if (target.kind === "sync") {
    return { url: `/api/repos/${target.repo}/remake`, body: {} };
  }
  return {
    url: `/api/repos/${target.repo}/pulls/${target.pr}/review`,
    body: target.model ? { model: target.model } : {},
  };
}

/** A failed row nobody dismissed and no later review resolved. */
function isOpenFailure(row: ActivityRow): boolean {
  return (
    row.state === "failed" &&
    !(row.job?.seen_at ?? row.review?.seen_at) &&
    !(row.job?.resolved_by ?? row.review?.resolved_by)
  );
}

/** What a failure became: dismissed, or resolved by a later review. */
function settledMark(row: ActivityRow): string {
  if (row.state !== "failed") return "";
  if (row.job?.resolved_by ?? row.review?.resolved_by) {
    return ` ${badge("emerald", "Resolved by a later review")}`;
  }
  if (row.job?.seen_at ?? row.review?.seen_at) {
    return ` ${badge("neutral", "Dismissed")}`;
  }
  return "";
}

function activityRow(row: ActivityRow, warning: string | undefined): string {
  const { job, review } = row;
  // Every row opens its log. A review whose job row is gone has no log left,
  // so it opens its result.
  const href = job
    ? `/activity/${job.id}`
    : review
      ? reviewResultHref(review)
      : "/activity";
  const label = job ? jobKindText(job) : review ? reviewKindText(review) : "";
  const resolved = Boolean(row.job?.resolved_by ?? row.review?.resolved_by);
  const target = resolved ? undefined : retryTarget(job, review);
  const open = isOpenFailure(row);
  const retry = target ? retryRequest(target) : undefined;
  const actions = [
    retry
      ? `<button class="btn sm" type="button" data-post="${escapeHtml(retry.url)}" data-body="${escapeHtml(
          JSON.stringify(retry.body),
        )}" data-next="here">Retry</button>`
      : "",
    open
      ? `<button class="btn out sm" type="button" data-post="/api/activity/dismiss" data-body="${escapeHtml(
          JSON.stringify({ keys: [row.key] }),
        )}" data-next="here">Dismiss</button>`
      : "",
  ].join("");
  return `<tr data-href="${escapeHtml(href)}" data-key="${escapeHtml(row.key)}"${
    open ? ` data-dismiss="1"` : ""
  }${retry ? ` data-retry="1"` : ""}>
    <td class="sel"><input type="checkbox" data-select aria-label="${escapeHtml(
      `Select ${label}`,
    )}"></td>
    <td class="wrap"><a class="strong" href="${escapeHtml(href)}">${text(label)}</a></td>
    <td class="wrap">${subjectCell(row)}</td>
    <td class="wrap">${resultCell(row)}${settledMark(row)}</td>
    <td class="num">${review ? formatCost(review) : ""}</td>
    <td class="muted">${when(row.at)}</td>
    <td>${statusCell(row)}${
      warning
        ? `<span class="warn-mark" role="img" aria-label="${escapeHtml(
            `Finished with a problem: ${warning}`,
          )}" title="${escapeHtml(`Finished with a problem: ${warning}`)}">${icon("triangle-alert")}</span>`
        : ""
    }</td>
    <td class="row-acts">${actions}</td>
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

/** What GitHub event a skipped row was, for a row with no pull request. */
const EVENT_WORDS: Record<string, string> = {
  pull_request: "Pull request",
  push: "Push",
  issue_comment: "Comment",
  issues: "Issue",
  pull_request_review: "Review",
  pull_request_review_comment: "Review comment",
  installation: "GitHub App installation",
  installation_repositories: "GitHub App repositories",
};

export type SkipGroup = { row: DeliveryRow; count: number };

/** The skipped list as it is shown: the same skip repeated within one
 * minute is one row with a count, the bot's own comments are left out
 * unless asked for, and an ignored event that gave no reason is noise, not
 * a skip. Rows come newest first. */
export function skipGroups(
  rows: DeliveryRow[],
  options: { own?: boolean } = {},
): { groups: SkipGroup[]; ownHidden: number } {
  const groups: SkipGroup[] = [];
  let ownHidden = 0;
  for (const row of rows) {
    if (row.outcome === "ignored" && !row.reason) continue;
    if (row.reason === "own-comment" && !options.own) {
      ownHidden++;
      continue;
    }
    const last = groups[groups.length - 1]?.row;
    if (
      last &&
      last.repo === row.repo &&
      last.pr_number === row.pr_number &&
      last.reason === row.reason &&
      last.outcome === row.outcome &&
      last.event === row.event &&
      last.received_at.slice(0, 16) === row.received_at.slice(0, 16)
    ) {
      groups[groups.length - 1]!.count++;
      continue;
    }
    groups.push({ row, count: 1 });
  }
  return { groups, ownHidden };
}

/** What a skipped row was about. A row with no repository says why it has
 * none instead of showing an empty cell. */
function skipSubject(row: DeliveryRow): string {
  const event = EVENT_WORDS[row.event] ?? row.event.replace(/_/g, " ");
  if (!row.repo) {
    const why = row.event.startsWith("installation")
      ? "about the whole installation, not one repository"
      : "GitHub sent no repository with it";
    return `${text(event)}<span class="sub">${text(`No repository: ${why}`)}</span>`;
  }
  const repoLink = `<a href="/repos/${text(row.repo)}">${text(row.repo)}</a>`;
  return row.pr_number
    ? `${repoLink} <a href="/repos/${text(row.repo)}/pulls/${row.pr_number}">#${row.pr_number}</a>`
    : `${repoLink}<span class="sub">${text(event)}</span>`;
}

function skippedCard(
  skipped: ReturnType<typeof skippedDeliveries>,
  query: ActivityQuery,
): string {
  const { groups, ownHidden } = skipGroups(skipped, { own: query.own });
  const rows = groups
    .slice(0, 20)
    .map(({ row, count }) => {
      const label = `${row.repo ?? ""}${row.pr_number ? ` #${row.pr_number}` : ""}`;
      // A pull request waiting for a request is one click from a review, and
      // the person on the dashboard is already allowed to ask.
      const action =
        row.repo && row.pr_number && isWaitingForRequest(row.reason)
          ? `<button class="btn sm" type="button" data-post="/api/repos/${text(row.repo)}/pulls/${row.pr_number}/review" aria-label="Review ${text(label)} now">Review now</button>`
          : "";
      const times = count > 1 ? ` ${badge("neutral", `${count} times`)}` : "";
      return `<tr><td class="wrap">${skipSubject(row)}</td>
        <td class="muted wrap">${text(reasonText(row.reason, row.outcome))}${times}</td>
        <td class="muted" style="width:120px">${when(row.received_at)}</td>
        <td style="width:110px;text-align:right">${action}</td></tr>`;
    })
    .join("");
  const ownToggle =
    ownHidden > 0 || query.own
      ? `<a class="btn out sm" href="${escapeHtml(
          activityHref(query, { own: query.own ? undefined : 1 }),
        )}">${
          query.own ? "Hide own comments" : `Show own comments (${ownHidden})`
        }</a>`
      : "";
  return `<div class="card">
    <div class="hd"><h2>Pull requests we skipped</h2>
      <span class="muted" style="margin-left:auto;font-size:13px">Why nothing happened</span>${ownToggle}</div>
    <div class="bd flush">${
      rows
        ? `<table class="fit"><thead><tr><th>What</th><th>Reason</th><th>When</th><th aria-label="Action"></th></tr></thead><tbody>${rows}</tbody></table>`
        : empty(
            "No skips recorded",
            ownHidden
              ? "Only the bot's own comments were skipped. They are hidden."
              : "Skipped pull request deliveries appear here.",
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
  /** The change stamp the page polls against, see `activityStamp`. */
  stamp = "",
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
        <thead><tr><th class="sel"><input type="checkbox" data-select-all aria-label="Select every row on this page"></th><th>What</th><th>Repository</th><th>Result</th><th class="num">Cost</th><th>When</th><th>Status</th><th aria-label="Actions"></th></tr></thead>
        <tbody>${feed.items
          .map((row) =>
            activityRow(row, row.job ? feed.warnings[row.job.id] : undefined),
          )
          .join("")}</tbody>
      </table>
      ${pager(feed, query)}`;
  const filterNotice = filtered
    ? `<div class="notice info"><div class="txt">Showing ${plural(
        feed.total,
        query.status === "failed" ? "failure" : "row",
      )} that ${feed.total === 1 ? "fits" : "fit"} this filter.</div><a class="btn out sm" href="/activity">Show all</a></div>`
    : "";
  // The failed list shows what still needs a look. Dismissed and resolved
  // failures stay in the history, one click away.
  const failedTools =
    query.status === "failed"
      ? `<div class="filters failed-tools">${
          query.settled
            ? `<a class="btn out sm" href="${escapeHtml(
                activityHref(query, { settled: undefined }),
              )}">Hide dismissed and resolved</a>`
            : feed.settled > 0
              ? `<a class="btn out sm" href="${escapeHtml(
                  activityHref(query, { settled: 1 }),
                )}">Show dismissed and resolved (${feed.settled})</a>`
              : ""
        }${
          !query.settled && feed.total > 0
            ? `<button class="btn out sm" type="button" data-post="/api/activity/dismiss" data-body="${escapeHtml(
                JSON.stringify(
                  query.repo ? { all: true, repo: query.repo } : { all: true },
                ),
              )}" data-next="here" data-confirm="${escapeHtml(
                `Dismiss ${plural(feed.total, "failure")}${query.repo ? ` of ${query.repo}` : ""}? They stay in the history.`,
              )}">Dismiss all</button>`
            : ""
        }</div>`
      : "";
  return html(
    layout({
      title: "Activity · co-maintainer",
      username,
      active: "/activity",
      body: `<div class="wrap" id="activity-root" data-stamp="${escapeHtml(stamp)}">
  <div class="pagehead">
    <div><h1>Activity</h1>
      <p class="lead">What is running now and what happened recently.</p></div>
  </div>
  ${live}
  ${filtersBlock(query, repos)}
  ${filterNotice}
  ${failedTools}
  <div class="card">
    <div class="hd"><h2>Recent</h2>${
      feed.items.length
        ? `<div class="bulk" data-bulk role="group" aria-label="Actions on the selected rows">
        <span class="muted" data-bulk-count role="status">None selected</span>
        <button class="btn sm" type="button" data-bulk-action="retry" disabled>Retry</button>
        <button class="btn out sm" type="button" data-bulk-action="dismiss" disabled>Dismiss</button>
      </div>`
        : ""
    }</div>
    <div class="bd flush">${recent}</div>
  </div>
  ${skippedCard(skipped, query)}
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
