import {
  bars,
  count,
  delta,
  duration,
  empty,
  html,
  layout,
  money,
  text,
} from "./layout.ts";
import { formatCostTotal } from "./cost.ts";
import type { statsForRange } from "../../services/dashboard.ts";
import { listJobs } from "../../store/jobs.ts";
import { pageHeader, segmented, statCard } from "./ui.ts";

export function renderAnalytics(
  username: string,
  range: string,
  data: ReturnType<typeof statsForRange>,
): Response {
  const failed = listJobs({ status: "failed" }).slice(0, 5);
  const current = ["7d", "30d", "90d"].includes(range) ? range : "30d";
  const kind = (name: (typeof data.byKind)[number]["kind"]) =>
    data.byKind.find((row) => row.kind === name)!;
  // Every review kind costs money, so Spent sums all of them, not only the
  // posted pull request reviews.
  const spent = data.byKind.reduce(
    (sum, row) => ({
      cost: sum.cost + row.cost,
      knownCount: sum.knownCount + row.knownCount,
      unknownCount: sum.unknownCount + row.unknownCount,
      byokUsd: sum.byokUsd + row.byokUsd,
      byokKnownCount: sum.byokKnownCount + row.byokKnownCount,
      byokUnknownCount: sum.byokUnknownCount + row.byokUnknownCount,
    }),
    { cost: 0, knownCount: 0, unknownCount: 0, byokUsd: 0, byokKnownCount: 0, byokUnknownCount: 0 },
  );
  const kindRows: [string, string, string][] = [
    ["init / sync", String(data.setupRuns), "Not recorded"],
    ["Pull request reviews", String(kind("posted").runs), formatCostTotal(kind("posted"))],
    ["Not posted reviews", String(kind("not_posted").runs), formatCostTotal(kind("not_posted"))],
    ["Failed attempts", String(kind("failed").runs), formatCostTotal(kind("failed"))],
    ["CLI reviews", String(kind("cli").runs), formatCostTotal(kind("cli"))],
  ];
  const byKind = `<table>
        <thead><tr><th>Kind</th><th class="num">Runs</th><th class="num">Cost</th></tr></thead>
        <tbody>
          ${kindRows
            .map(
              ([label, runs, cost]) =>
                `<tr><td>${text(label)}</td><td class="num">${runs}</td><td class="num">${text(cost)}</td></tr>`,
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
                `<tr><td><a href="/repos/${text(row.repo)}">${text(row.repo)}</a></td>
            <td class="num">${row.pullRequests}</td>
            <td class="num">${row.findings}</td>
            <td class="num">${
              row.pullRequests
                ? (row.findings / row.pullRequests).toFixed(1)
                : "0"
            }</td>
            <td class="num">${count(row.tokensIn + row.tokensOut)}</td>
            <td class="num">${duration(row.avgDurationMs)}</td>
            <td class="num">${formatCostTotal(row)}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>`;
  const byModel =
    data.byModel.length === 0
      ? empty("No models yet", "Each review records the model that wrote it.")
      : `<table>
        <thead><tr><th>Model</th><th class="num">Reviews</th><th class="num">Tokens in</th>
          <th class="num">Tokens out</th><th class="num">Average review</th>
          <th class="num">Per review</th><th class="num">Cost</th></tr></thead>
        <tbody>
          ${data.byModel
            .map(
              (row) =>
                `<tr><td>${text(row.model)}</td>
            <td class="num">${row.reviews}</td>
            <td class="num">${count(row.tokensIn)}</td>
            <td class="num">${count(row.tokensOut)}</td>
            <td class="num">${duration(row.avgDurationMs)}</td>
            <td class="num">${
              row.knownCount
                ? money(row.cost / row.knownCount)
                : row.unknownCount
                  ? "unknown"
                  : money(0)
            }</td>
            <td class="num">${formatCostTotal(row)}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>`;
  const byRemoteToken =
    (data.byRemoteToken ?? []).length === 0
      ? empty("No remote reviews yet", "Usage from CLI tokens appears here.")
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
            <td class="num">${formatCostTotal(row)}</td></tr>`,
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
                `<tr><td>${text(row.severity)}</td>
            <td class="num">${row.findings}</td>
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
        <a class="btn" href="/activity">See why</a>
        <button class="dismiss-worth" type="button" data-dismiss-worth="${text(
          job.id,
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
    lead: `Last ${data.days} days`,
    actions: segmented(
      ["7d", "30d", "90d"].map((value) => ({
        label: value,
        href: `/usage?range=${value}`,
        on: value === current,
      })),
    ),
  })}
  <div class="stats">
    ${statCard({
      label: "Spent",
      value: formatCostTotal(spent),
      hint: `${count(data.totals.tokensIn + data.totals.tokensOut)} tokens · ${count(
        data.totals.tokensIn,
      )} in and ${count(data.totals.tokensOut)} out${delta(data.change.cost, data.days, true)}`,
      icon: "coins",
    })}
    ${statCard({
      label: "Reviews",
      value: String(kind("posted").runs + kind("not_posted").runs),
      hint: [
        kind("failed").runs > 0
          ? `${kind("failed").runs} failed ${kind("failed").runs === 1 ? "attempt" : "attempts"}`
          : "",
        kind("not_posted").runs > 0 ? `${kind("not_posted").runs} not posted` : "",
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
      icon: "git-pull-request",
    })}
    ${statCard({
      label: "Findings",
      value: String(data.totals.findings),
      hint: `${data.totals.pullRequests} pull requests${delta(data.change.findings, data.days)}`,
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
          label: `${row.day} ${formatCostTotal(row)} over ${row.reviews} reviews`,
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
(function() {
  var key = "co-maintainer:dismissed-worth";
  var read = function() {
    try {
      var value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  };
  var dismissed = read();
  document.querySelectorAll("[data-worth-id]").forEach(function(item) {
    if (dismissed.indexOf(item.getAttribute("data-worth-id")) !== -1) {
      item.remove();
    }
  });
  document.addEventListener("click", function(event) {
    var button = event.target.closest("[data-dismiss-worth]");
    if (!button) return;
    var id = button.getAttribute("data-dismiss-worth");
    if (!id) return;
    var next = read();
    if (next.indexOf(id) === -1) next.push(id);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch (_) {}
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
