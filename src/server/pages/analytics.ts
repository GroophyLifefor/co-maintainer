import { empty, html, layout, money, text } from "./layout.ts";
import type { statsForRange } from "../../services/dashboard.ts";
import { listJobs } from "../../store/jobs.ts";

export function renderAnalytics(
  username: string,
  range: string,
  data: ReturnType<typeof statsForRange>,
): Response {
  const failed = listJobs({ status: "failed" }).slice(0, 5);
  const byRepo = data.byRepo.length === 0
    ? empty("No usage yet", "Cost and findings show up after reviews run.")
    : `<table>
        <thead><tr><th>Repository</th><th class="num">Pull requests</th><th class="num">Findings</th>
          <th class="num">Per pull request</th><th class="num">Cost</th></tr></thead>
        <tbody>
          ${
      data.byRepo.map((row) =>
        `<tr><td><a href="/repos/${text(row.repo)}">${text(row.repo)}</a></td>
            <td class="num">${row.pullRequests}</td>
            <td class="num">${row.findings}</td>
            <td class="num">${
          row.pullRequests ? (row.findings / row.pullRequests).toFixed(1) : "0"
        }</td>
            <td class="num">${money(row.cost)}</td></tr>`
      ).join("")
    }
        </tbody>
      </table>`;
  const looks = failed.length === 0
    ? empty("Nothing stands out", "Failed jobs will be listed here.")
    : failed.map((job) =>
      `<div class="notice bad" style="margin-bottom:12px">
        <div class="txt"><b>${text(job.repo)}</b>. ${text(job.type)} failed${
        job.error ? `. ${text(job.error)}` : ""
      }.</div>
        <a class="btn" href="/activity">See why</a>
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
    <div class="kfig">
      <div><div class="k">Pull requests reviewed</div><div class="big">${data.totals.pullRequests}</div></div>
      <div><div class="k">Findings</div><div class="big">${data.totals.findings}</div></div>
      <div><div class="k">Cost</div><div class="big">${
      money(data.totals.cost)
    }</div></div>
    </div>
  </div></div>
  <div class="card">
    <div class="hd"><h2>By repository</h2></div>
    <div class="bd flush">${byRepo}</div>
  </div>
  <div class="card">
    <div class="hd"><h2>Worth a look</h2></div>
    <div class="bd">${looks}</div>
  </div>
</div>
<script>
document.getElementById("range").addEventListener("change", function() {
  location.href = "/analytics?range=" + this.value;
});
</script>`,
  }));
}
