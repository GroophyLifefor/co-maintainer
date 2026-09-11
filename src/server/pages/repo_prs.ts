import {
  empty,
  html,
  layout,
  money,
  repoNav,
  skSlot,
  text,
  when,
} from "./layout.ts";
import type { repoPulls } from "../../services/dashboard.ts";

export function renderRepoPulls(
  username: string,
  fullName: string,
  data: ReturnType<typeof repoPulls>,
): Response {
  const start = (data.page - 1) * data.per + 1;
  const end = Math.min(data.page * data.per, data.total);
  const pager = data.total === 0 ? "" : `<div class="pager">
          <span>${start}-${end} of ${data.total}</span>
          <span class="sp"></span>
          ${
    data.page > 1
      ? `<a class="btn sm" href="?page=${data.page - 1}">Previous</a>`
      : `<button class="btn sm" disabled>Previous</button>`
  }
          ${
    end < data.total
      ? `<a class="btn sm" href="?page=${data.page + 1}">Next</a>`
      : `<button class="btn sm" disabled>Next</button>`
  }
        </div>`;
  const table = data.items.length === 0
    ? empty(
      "No pull requests reviewed",
      "A review of an open pull request will show up here.",
    )
    : `<table>
          <thead><tr><th>Pull request</th><th>Last reviewed</th>
            <th class="num">Findings</th><th class="num">Cost</th></tr></thead>
          <tbody>
            ${
      data.items.map((item) =>
        `<tr><td><a href="/repos/${
          text(fullName)
        }/pulls/${item.pr_number}">#${item.pr_number}</a></td>
              <td class="muted">${when(item.last_reviewed)}</td>
              <td class="num">${item.findings}</td>
              <td class="num">${money(item.cost)}</td></tr>`
      ).join("")
    }
          </tbody>
        </table>${pager}`;
  const [owner, repo] = fullName.split("/");
  const reviewBase = `/api/repos/${encodeURIComponent(owner)}/${
    encodeURIComponent(repo)
  }/pulls/`;
  return html(layout({
    title: `Pull requests · ${fullName}`,
    username,
    body: `<div class="wrap side">
  ${repoNav(fullName, "pulls")}
  <div>
    <div class="crumbs"><a href="/">Repositories</a> /
      <a href="/repos/${text(fullName)}">${
      text(fullName)
    }</a> / Pull requests</div>
    <div class="pagehead">
      <div><h1>Pull requests</h1>
        <p class="lead">${data.stats.pullRequests} reviewed in the last 30 days</p></div>
    </div>
    <div data-async>
      ${skSlot()}
      <div class="card"><div class="bd">
        <h2>Review a pull request</h2>
        <p class="lead">Enter an open pull request number to start a review.</p>
        <form id="manual-review" style="display:flex;align-items:end;gap:8px;margin-top:14px">
          <div style="width:180px">
            <label for="pr-number">PR number</label>
            <input id="pr-number" name="prNumber" type="number" min="1" step="1" required>
          </div>
          <button class="primary" type="submit">Start review</button>
        </form>
      </div></div>
    </div>
    <div class="card"><div class="bd flush">${table}</div></div>
  </div>
</div>
<script>
document.getElementById("manual-review").addEventListener("submit", function(event) {
  event.preventDefault();
  var input = document.getElementById("pr-number");
  var number = Number(input.value);
  if (!Number.isSafeInteger(number) || number < 1) {
    input.focus();
    return;
  }
  postAndGo(${
      JSON.stringify(reviewBase)
    } + number + "/review", {}, "/activity", this.querySelector("button"));
});
</script>`,
  }));
}
