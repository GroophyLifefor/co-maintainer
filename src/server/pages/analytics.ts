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
import type { statsForRange } from "../../services/dashboard.ts";
import { listJobs } from "../../store/jobs.ts";

export function renderAnalytics(
  username: string,
  range: string,
  data: ReturnType<typeof statsForRange>,
): Response {
  const failed = listJobs({ status: "failed" }).slice(0, 5);
  const totalFindings = data.bySeverity.reduce(
    (sum, row) => sum + row.findings,
    0,
  );
  const byRepo = data.byRepo.length === 0
    ? empty("No usage yet", "Cost and findings show up after reviews run.")
    : `<table>
        <thead><tr><th>Repository</th><th class="num">Pull requests</th><th class="num">Findings</th>
          <th class="num">Per pull request</th><th class="num">Tokens</th>
          <th class="num">Average review</th><th class="num">Cost</th></tr></thead>
        <tbody>
          ${
      data.byRepo.map((row) =>
        `<tr><td><a href="/repos/${text(row.repo)}">${text(row.repo)}</a></td>
            <td class="num">${row.pullRequests}</td>
            <td class="num">${row.findings}</td>
            <td class="num">${
          row.pullRequests ? (row.findings / row.pullRequests).toFixed(1) : "0"
        }</td>
            <td class="num">${count(row.tokensIn + row.tokensOut)}</td>
            <td class="num">${duration(row.avgDurationMs)}</td>
            <td class="num">${money(row.cost)}</td></tr>`
      ).join("")
    }
        </tbody>
      </table>`;
  const byModel = data.byModel.length === 0
    ? empty("No models yet", "Each review records the model that wrote it.")
    : `<table>
        <thead><tr><th>Model</th><th class="num">Reviews</th><th class="num">Tokens in</th>
          <th class="num">Tokens out</th><th class="num">Average review</th>
          <th class="num">Per review</th><th class="num">Cost</th></tr></thead>
        <tbody>
          ${
      data.byModel.map((row) =>
        `<tr><td>${text(row.model)}</td>
            <td class="num">${row.reviews}</td>
            <td class="num">${count(row.tokensIn)}</td>
            <td class="num">${count(row.tokensOut)}</td>
            <td class="num">${duration(row.avgDurationMs)}</td>
            <td class="num">${
          money(row.reviews ? row.cost / row.reviews : 0)
        }</td>
            <td class="num">${money(row.cost)}</td></tr>`
      ).join("")
    }
        </tbody>
      </table>`;
  const bySeverity = data.bySeverity.length === 0
    ? empty("No findings yet", "Severity shows how much of the noise matters.")
    : `<table>
        <thead><tr><th>Severity</th><th class="num">Findings</th><th class="num">Share</th>
          <th class="num">Posted</th><th class="num">Raised again</th></tr></thead>
        <tbody>
          ${
      data.bySeverity.map((row) =>
        `<tr><td>${text(row.severity)}</td>
            <td class="num">${row.findings}</td>
            <td class="num">${
          totalFindings ? Math.round((row.findings / totalFindings) * 100) : 0
        }%</td>
            <td class="num">${row.posted}</td>
            <td class="num">${row.repeats}</td></tr>`
      ).join("")
    }
        </tbody>
      </table>`;
  const busiest = data.byDay.reduce(
    (best, row) => (row.cost > best.cost ? row : best),
    { day: "", cost: 0, reviews: 0, findings: 0 },
  );
  const looks = failed.length === 0
    ? empty("Nothing stands out", "Failed jobs will be listed here.")
    : failed.map((job) =>
      `<div class="notice bad worth-item" data-worth-id="${
        text(job.id)
      }" style="margin-bottom:12px">
        <div class="txt"><b>${text(job.repo)}</b>. ${text(job.type)} failed${
        job.error ? `. ${text(job.error)}` : ""
      }.</div>
        <a class="btn" href="/activity">See why</a>
        <button class="dismiss-worth" type="button" data-dismiss-worth="${
        text(job.id)
      }" aria-label="Dismiss">×</button>
      </div>`
    ).join("");
  return html(layout({
    title: "Usage · co-maintainer",
    username,
    active: "analytics",
    body: `<div class="wrap">
  <div class="pagehead">
    <div><h1>Usage</h1>
      <p class="lead">Last ${data.days} days</p></div>
    <div class="actions">
      <select id="range" style="width:150px">
        <option value="7d"${
      range === "7d" ? " selected" : ""
    }>Last 7 days</option>
        <option value="30d"${
      range === "30d" ? " selected" : ""
    }>Last 30 days</option>
        <option value="90d"${
      range === "90d" ? " selected" : ""
    }>Last 90 days</option>
      </select>
    </div>
  </div>
  <div class="card"><div class="bd">
    <div class="kfig wrap4">
      <div><div class="k">Pull requests reviewed</div><div class="big">${data.totals.pullRequests}</div>${
      delta(data.change.pullRequests, data.days)
    }</div>
      <div><div class="k">Findings</div><div class="big">${data.totals.findings}</div>${
      delta(data.change.findings, data.days)
    }</div>
      <div><div class="k">Cost</div><div class="big">${
      money(data.totals.cost)
    }</div>${delta(data.change.cost, data.days, true)}</div>
      <div><div class="k">Tokens</div><div class="big">${
      count(data.totals.tokensIn + data.totals.tokensOut)
    }</div><div class="trend">${count(data.totals.tokensIn)} in and ${
      count(data.totals.tokensOut)
    } out</div></div>
      <div><div class="k">Average review</div><div class="big">${
      duration(data.totals.avgDurationMs)
    }</div></div>
      <div><div class="k">Rounds per pull request</div><div class="big">${
      data.totals.pullRequests
        ? (data.totals.reviews / data.totals.pullRequests).toFixed(1)
        : "0"
    }</div>${
      data.totals.failed
        ? `<div class="trend down">${data.totals.failed} failed</div>`
        : ""
    }</div>
    </div>
  </div></div>
  <div class="card">
    <div class="hd"><h2>Cost per day</h2></div>
    <div class="bd">
      ${
      bars(data.byDay.map((row) => ({
        label: `${row.day} ${money(row.cost)} over ${row.reviews} reviews`,
        value: row.cost,
      })))
    }
      <p class="muted" style="margin:10px 0 0">${
      busiest.cost
        ? `Busiest day was ${text(busiest.day)} at ${money(busiest.cost)}`
        : "No spend in this range"
    }</p>
    </div>
  </div>
  <div class="card">
    <div class="hd"><h2>By repository</h2></div>
    <div class="bd flush">${byRepo}</div>
  </div>
  <div class="card">
    <div class="hd"><h2>By model</h2></div>
    <div class="bd flush">${byModel}</div>
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
document.getElementById("range").addEventListener("change", function() {
  location.href = "/analytics?range=" + this.value;
});
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
  }));
}
