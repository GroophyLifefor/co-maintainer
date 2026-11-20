import { listActivity } from "../../store/activity.ts";
import { openFailureWindow } from "../../services/open_failures.ts";
import { getRepo } from "../../store/repos.ts";
import {
  bars,
  count,
  delta,
  duration,
  empty,
  escapeHtml,
  html,
  layout,
  money,
  plural,
  text,
} from "./layout.ts";
import { costTotalParts, formatCostCell, formatCostTotal } from "./cost.ts";
import type { statsForRange } from "../../services/dashboard.ts";
import { icon, pageHeader, segmented, statCard } from "./ui.ts";
import { findingsHref } from "./findings.ts";
import { severityName } from "./finding_bits.ts";
import { usageHref, type UsageQuery } from "./usage_query.ts";

/** The Usage filters: a repository and an author beside the range. Each
 * select submits on change, and the form works without the script too. */
function usageFilters(
  query: UsageQuery,
  choices: { repos: string[]; authors: string[] },
): string {
  const select = (
    name: "repo" | "author",
    label: string,
    all: string,
    values: string[],
  ) => {
    // A value from a link that is not in this range still shows as chosen.
    const current = query[name];
    const options =
      current && !values.includes(current) ? [current, ...values] : values;
    return `<select class="inp" name="${name}" aria-label="${label}" style="width:auto" data-usage-filter>
      <option value="">${all}</option>
      ${options
        .map(
          (value) =>
            `<option value="${escapeHtml(value)}"${
              value === current ? " selected" : ""
            }>${text(value)}</option>`,
        )
        .join("")}
    </select>`;
  };
  return `<form class="filters" method="get" action="/usage" id="usage-filters">
    <input type="hidden" name="range" value="${query.range}">
    ${select("repo", "Repository", "All repositories", choices.repos)}
    ${select("author", "Author", "All authors", choices.authors)}
    <noscript><button type="submit" class="btn out sm">Filter</button></noscript>
    <a class="btn out sm" href="${escapeHtml(
      usageHref(query, {}, "/usage/export.csv"),
    )}" download>${icon("download")}Export CSV</a>
  </form>`;
}

export function renderAnalytics(
  username: string,
  query: UsageQuery,
  data: ReturnType<typeof statsForRange>,
): Response {
  // The same open failures the menu badge counts: in the same window, and
  // without the ones someone dismissed or a later review resolved.
  const failed = listActivity(
    {
      state: "failed",
      sinceIso: openFailureWindow().sinceIso,
      repo: query.repo,
    },
    5,
    0,
  ).items.flatMap((row) => (row.job ? [{ ...row.job, key: row.key }] : []));
  const current = query.range;
  // The day the range starts on, for links to lists that filter by day.
  const fromDay = data.since.slice(0, 10);
  const kind = (name: (typeof data.byKind)[number]["kind"]) =>
    data.byKind.find((row) => row.kind === name)!;
  const aiKind = (name: "knowledge" | "reply" | "watch") =>
    data.aiByKind?.find((row) => row.kind === name);
  // Every review kind costs money, and so do knowledge builds, replies and
  // watch comments, so Spent sums all of them.
  const spent = [...data.byKind, ...(data.aiByKind ?? [])].reduce(
    (sum, row) => ({
      cost: sum.cost + row.cost,
      knownCount: sum.knownCount + row.knownCount,
      unknownCount: sum.unknownCount + row.unknownCount,
      byokUsd: sum.byokUsd + row.byokUsd,
      byokKnownCount: sum.byokKnownCount + row.byokKnownCount,
      byokUnknownCount: sum.byokUnknownCount + row.byokUnknownCount,
    }),
    {
      cost: 0,
      knownCount: 0,
      unknownCount: 0,
      byokUsd: 0,
      byokKnownCount: 0,
      byokUnknownCount: 0,
    },
  );
  const spentParts = costTotalParts(spent);
  const kindRows: [string, string, string][] = [
    ...(data.setupRuns === undefined
      ? []
      : [
          [
            "init / sync",
            String(data.setupRuns),
            formatCostCell(aiKind("knowledge")!),
          ] as [string, string, string],
          [
            "Replies to comments",
            String(aiKind("reply")?.runs ?? 0),
            formatCostCell(aiKind("reply")!),
          ] as [string, string, string],
          [
            "Watch comments",
            String(aiKind("watch")?.runs ?? 0),
            formatCostCell(aiKind("watch")!),
          ] as [string, string, string],
        ]),
    [
      "Pull request reviews",
      String(kind("posted").runs),
      formatCostCell(kind("posted")),
    ],
    [
      "Not posted reviews",
      String(kind("not_posted").runs),
      formatCostCell(kind("not_posted")),
    ],
    [
      "Failed review attempts",
      String(kind("failed").runs),
      formatCostCell(kind("failed")),
    ],
    [
      "Stopped reviews",
      String(kind("canceled").runs),
      formatCostCell(kind("canceled")),
    ],
    ...(kind("running").runs > 0
      ? [
          [
            "Running now",
            String(kind("running").runs),
            formatCostCell(kind("running")),
          ] as [string, string, string],
        ]
      : []),
    ["Push reviews", String(kind("push").runs), formatCostCell(kind("push"))],
    [
      "Remote reviews from the CLI",
      String(kind("cli").runs),
      formatCostCell(kind("cli")),
    ],
    [
      "Local and pull request reviews from the CLI",
      String(kind("local").runs),
      formatCostCell(kind("local")),
    ],
  ];
  const byKind = `<table>
        <thead><tr><th>Kind</th><th class="num">Runs</th><th class="num">Cost</th></tr></thead>
        <tbody>
          ${kindRows
            .map(
              ([label, runs, cost]) =>
                `<tr><td>${text(label)}</td><td class="num">${runs}</td><td class="num">${cost}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>`;
  const totalFindings = data.bySeverity.reduce(
    (sum, row) => sum + row.findings,
    0,
  );
  const byRepo =
    data.byRepo.length === 0
      ? empty("No usage yet", "Cost and findings show up after reviews run.")
      : `<table>
        <thead><tr><th>Repository</th><th class="num">Pull requests</th><th class="num">Findings</th>
          <th class="num">Per pull request</th><th class="num">Tokens</th>
          <th class="num">Average review</th><th class="num">Cost</th></tr></thead>
        <tbody>
          ${data.byRepo
            .map(
              (row) =>
                `<tr><td>${
                  getRepo(row.repo)?.active === 1
                    ? `<a href="/repos/${text(row.repo)}">${text(row.repo)}</a>`
                    : getRepo(row.repo)
                      ? `${text(row.repo)} <span class="muted">(removed)</span>`
                      : `${text(row.repo)} <span class="muted">(not on the dashboard)</span>`
                }</td>
            <td class="num">${row.pullRequests}</td>
            <td class="num">${row.findings}</td>
            <td class="num">${
              row.pullRequests
                ? (row.findings / row.pullRequests).toFixed(1)
                : "0"
            }</td>
            <td class="num">${count(row.tokensIn + row.tokensOut)}</td>
            <td class="num">${duration(row.avgDurationMs)}</td>
            <td class="num">${formatCostCell(row)}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>`;
  const byModel =
    data.byModel.length === 0
      ? empty("No models yet", "Each review records the model that wrote it.")
      : // Four columns, each figure with its detail on a second line, so the
        // table fits its half of the row at desktop width without scrolling.
        `<table class="fit">
        <thead><tr><th>Model</th><th class="num">Reviews</th><th class="num">Tokens</th>
          <th class="num">Cost</th></tr></thead>
        <tbody>
          ${data.byModel
            .map(
              (row) =>
                `<tr><td class="wrap">${text(row.model)}<span class="sub">${text(
                  `${duration(row.avgDurationMs)} average`,
                )}</span></td>
            <td class="num">${row.reviews}</td>
            <td class="num">${count(row.tokensIn)} in<span class="sub">${count(
              row.tokensOut,
            )} out</span></td>
            <td class="num">${formatCostCell(row)}<span class="sub">${text(
              row.knownCount
                ? `${money(row.cost / row.knownCount)} per review`
                : row.unknownCount
                  ? "unknown per review"
                  : `${money(0)} per review`,
            )}</span></td></tr>`,
            )
            .join("")}
        </tbody>
      </table>`;
  const byRemoteToken =
    (data.byRemoteToken ?? []).length === 0
      ? empty("No remote reviews yet", {
          html: `Usage from <a href="/settings/remote">CLI tokens</a> appears here.`,
        })
      : `<table>
        <thead><tr><th>Token</th><th class="num">Reviews</th><th class="num">Findings</th>
          <th class="num">Cost</th></tr></thead>
        <tbody>
          ${(data.byRemoteToken ?? [])
            .map(
              (row) =>
                `<tr><td>${text(row.tokenName)}</td>
            <td class="num">${row.reviews}</td>
            <td class="num">${row.findings}</td>
            <td class="num">${formatCostCell(row)}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>`;
  const bySeverity =
    data.bySeverity.length === 0
      ? empty(
          "No findings yet",
          "Severity shows how much of the noise matters.",
        )
      : `<table>
        <thead><tr><th>Severity</th><th class="num">Findings</th><th class="num">Share</th>
          <th class="num">Posted</th><th class="num">Raised again</th></tr></thead>
        <tbody>
          ${data.bySeverity
            .map(
              (row) =>
                `<tr><td><a href="${escapeHtml(
                  findingsHref(query.repo, {
                    severity: row.severity,
                    state: "all",
                    days: data.days,
                    author: query.author,
                  }),
                )}">${text(row.severity)} ${text(severityName(row.severity))}</a></td>
            <td class="num"><a href="${escapeHtml(
              findingsHref(query.repo, {
                severity: row.severity,
                state: "all",
                days: data.days,
                author: query.author,
              }),
            )}">${row.findings}</a></td>
            <td class="num">${
              totalFindings
                ? Math.round((row.findings / totalFindings) * 100)
                : 0
            }%</td>
            <td class="num">${row.posted}</td>
            <td class="num">${row.repeats}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>`;
  const busiest = data.byDay.reduce(
    (best, row) => (row.cost > best.cost ? row : best),
    {
      day: "",
      cost: 0,
      reviews: 0,
      findings: 0,
      knownCount: 0,
      unknownCount: 0,
      byokUsd: 0,
      byokKnownCount: 0,
      byokUnknownCount: 0,
    },
  );
  const looks =
    failed.length === 0
      ? empty("Nothing stands out", "Failed jobs will be listed here.")
      : failed
          .map(
            (job) =>
              `<div class="notice bad worth-item" data-worth-id="${text(
                job.id,
              )}" style="margin-bottom:12px">
        <div class="txt"><b>${text(job.repo)}</b>. ${text(job.type)} failed${
          job.error ? `. ${text(job.error)}` : ""
        }.</div>
        <a class="btn" href="/activity/${text(job.id)}">See why</a>
        <button class="dismiss-worth" type="button" data-dismiss-worth="${text(
          job.key,
        )}" aria-label="Dismiss">×</button>
      </div>`,
          )
          .join("");
  return html(
    layout({
      title: "Usage · co-maintainer",
      username,
      active: "/usage",
      body: `<div class="wrap">
  ${pageHeader({
    title: "Usage",
    lead: [
      `Last ${data.days} days`,
      query.repo ? query.repo : "",
      query.author ? `pull requests by ${query.author}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    actions: segmented(
      (["7d", "30d", "90d"] as const).map((value) => ({
        label: value,
        href: usageHref(query, { range: value }),
        on: value === current,
      })),
    ),
  })}
  ${usageFilters(query, data.choices)}
  <div class="stats">
    ${statCard({
      label: "Spent",
      value: text(spentParts.value),
      hint: `${spentParts.note ? `${text(spentParts.note)}<br>` : ""}${plural(count(data.totals.tokensIn + data.totals.tokensOut), "token")} · ${count(
        data.totals.tokensIn,
      )} in and ${count(data.totals.tokensOut)} out${delta(data.change.cost, data.days, true)}`,
      icon: "coins",
    })}
    ${statCard({
      label: "Reviews",
      value: String(data.totals.completed),
      hint: [
        plural(data.totals.pullRequests, "pull request"),
        // Every failed attempt of the range, dismissed ones too. Activity
        // has no author filter, so with one set the figure stays text.
        data.totals.failed > 0
          ? query.author
            ? plural(data.totals.failed, "failed attempt")
            : `<a href="${escapeHtml(
                `/activity?${new URLSearchParams({
                  ...(query.repo ? { repo: query.repo } : {}),
                  status: "failed",
                  settled: "1",
                  kind: "review",
                  from: fromDay,
                }).toString()}`,
              )}">${plural(data.totals.failed, "failed attempt")}</a>`
          : "",
        data.totals.notPosted > 0 ? `${data.totals.notPosted} not posted` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      icon: "git-pull-request",
    })}
    ${statCard({
      label: "Findings",
      // Counted the way the Findings list counts, so the number opens a list
      // with exactly that many findings.
      value: `<a href="${escapeHtml(
        findingsHref(query.repo, {
          state: "all",
          days: data.days,
          author: query.author,
        }),
      )}">${totalFindings}</a>`,
      hint: delta(data.change.findings, data.days) || undefined,
      icon: "flag",
    })}
    ${statCard({
      label: "Avg. review",
      value: duration(data.totals.avgDurationMs),
      icon: "timer",
    })}
  </div>
  <div class="cols c11">
    <div class="card">
      <div class="hd"><h2>By kind</h2></div>
      <div class="bd flush">${byKind}</div>
    </div>
    <div class="card">
      <div class="hd"><h2>By model</h2></div>
      <div class="bd flush">${byModel}</div>
    </div>
  </div>
  <div class="card">
    <div class="hd"><h2>Cost per day</h2></div>
    <div class="bd">
      ${bars(
        data.byDay.map((row) => ({
          label: `${row.day} ${formatCostTotal(row)} over ${plural(row.reviews, "review")}`,
          value: row.cost,
        })),
      )}
      <p class="muted" style="margin:10px 0 0">${
        busiest.cost > 0 || busiest.unknownCount > 0
          ? `Busiest day was ${text(busiest.day)} at ${formatCostTotal(busiest)}`
          : "No spend in this range"
      }</p>
    </div>
  </div>
  <div class="card">
    <div class="hd"><h2>By repository</h2></div>
    <div class="bd flush">${byRepo}</div>
  </div>
  <div class="card">
    <div class="hd"><h2>By remote token</h2></div>
    <div class="bd flush">${byRemoteToken}</div>
  </div>
  <div class="card">
    <div class="hd"><h2>Findings by severity</h2></div>
    <div class="bd flush">${bySeverity}</div>
  </div>
  <div class="card" id="worth-a-look">
    <div class="hd"><h2>Worth a look</h2></div>
    <div class="bd">${looks}</div>
  </div>
</div>
<script>
document.querySelectorAll("[data-usage-filter]").forEach(function(select) {
  select.addEventListener("change", function() {
    select.form.submit();
  });
});
(function() {
  // Dismissing here is the same dismiss the Activity list does, so the
  // failure leaves the menu badge and the failed list too.
  document.addEventListener("click", async function(event) {
    var button = event.target.closest("[data-dismiss-worth]");
    if (!button) return;
    var key = button.getAttribute("data-dismiss-worth");
    if (!key) return;
    button.disabled = true;
    try {
      var response = await fetch("/api/activity/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "fetch" },
        body: JSON.stringify({ keys: [key] })
      });
      if (!response.ok) throw new Error(String(response.status));
    } catch (_) {
      button.disabled = false;
      return;
    }
    var item = button.closest("[data-worth-id]");
    if (item) item.remove();
    if (!document.querySelector("[data-worth-id]")) {
      document.querySelector("#worth-a-look .bd").textContent =
        "Nothing stands out.";
    }
  });
})();
</script>`,
    }),
  );
}
