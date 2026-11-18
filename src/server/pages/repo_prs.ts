import { empty, html, layout, skSlot, text, when } from "./layout.ts";
import { repoHeader, shortcutsBar } from "./ui.ts";
import { formatCostTotal } from "./cost.ts";
import type { repoPulls } from "../../services/dashboard.ts";
import type { OpenPull } from "../../github/app.ts";

export function renderRepoPulls(
  username: string,
  fullName: string,
  data: ReturnType<typeof repoPulls>,
  open: { pulls: OpenPull[] | undefined; appConfigured: boolean },
): Response {
  const start = (data.page - 1) * data.per + 1;
  const end = Math.min(data.page * data.per, data.total);
  const pager =
    data.total === 0
      ? ""
      : `<div class="pager">
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
  const table =
    data.items.length === 0
      ? empty(
          "No pull requests reviewed",
          "A review of an open pull request will show up here.",
        )
      : `<table data-kb-list>
          <thead><tr><th>Pull request</th><th>Last reviewed</th>
            <th class="num">Findings</th><th class="num">Cost</th></tr></thead>
          <tbody>
            ${data.items
              .map(
                (item) =>
                  `<tr data-href="/repos/${text(fullName)}/pulls/${item.pr_number}" style="cursor:pointer"><td><a href="/repos/${text(
                    fullName,
                  )}/pulls/${item.pr_number}">#${item.pr_number}</a></td>
              <td class="muted">${when(item.last_reviewed)}</td>
              <td class="num">${item.findings}</td>
              <td class="num">${formatCostTotal(item)}</td></tr>`,
              )
              .join("")}
          </tbody>
        </table>${pager}`;
  const [owner, repo] = fullName.split("/");
  const reviewBase = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/`;
  const escape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const openList = open.pulls
    ? open.pulls.length === 0
      ? `<div class="empty"><h2>No open pull requests</h2><p>Open one on GitHub and it will appear here.</p></div>`
      : `<table data-kb-list>
          <thead><tr><th>Pull request</th><th>Author</th><th>Branch</th>
            <th>Updated</th><th></th></tr></thead>
          <tbody>
            ${open.pulls
              .map(
                (pull) =>
                  `<tr data-href="/repos/${text(fullName)}/pulls/${pull.number}" style="cursor:pointer"><td><a href="/repos/${text(
                    fullName,
                  )}/pulls/${pull.number}">#${pull.number}</a>
              ${escape(pull.title)}</td>
              <td class="muted">${escape(pull.author)}</td>
              <td class="muted mono">${escape(pull.headRef)}</td>
              <td class="muted">${when(pull.updatedAt)}</td>
              <td class="num"><button class="btn sm" type="button"
                data-review-pr="${pull.number}">Review</button></td></tr>`,
              )
              .join("")}
          </tbody>
        </table>`
    : open.appConfigured
      ? `<div class="empty"><h2>Open pull requests are unavailable</h2><p>GitHub did not return a list. You can still start a review by number below.</p></div>`
      : empty(
          "Configure the GitHub App to list open pull requests",
          {
            html: `Connect it in <a href="/settings/github">Settings</a>. Without it, start a review by number below.`,
          },
          `<a class="btn out sm" href="/settings/github">GitHub settings</a>`,
        );
  return html(
    layout({
      title: `Pull requests · ${fullName}`,
      username,
      active: "/",
      body: `<div class="wrap">
  ${repoHeader({
    fullName,
    tab: "pulls",
    title: "Pull requests",
    tabLabel: "Pull requests",
    lead: `${data.stats.pullRequests} reviewed in the last 30 days`,
  })}
  <div>
    <div data-async>
      ${skSlot()}
      <div class="card"><div class="bd flush">${openList}</div></div>
    </div>
    <div data-async>
      ${skSlot()}
      <div class="card"><div class="bd">
        <h2>Review a pull request</h2>
        <p class="lead">Enter an open pull request number to start a review.</p>
        <form id="manual-review" style="display:flex;align-items:end;gap:8px;margin-top:14px">
          <div style="width:180px">
            <label for="pr-number">PR number</label>
            <input id="pr-number" name="prNumber" type="number" min="1" step="1" required data-kb-search>
          </div>
          <button class="primary" type="submit">Start review</button>
        </form>
      </div></div>
    </div>
    <div class="card"><div class="bd flush">${table}</div></div>
    ${
      data.items.length || open.pulls?.length
        ? shortcutsBar({ searchLabel: "pull request number" })
        : ""
    }
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
  postAndGo(${JSON.stringify(
    reviewBase,
  )} + number + "/review", {}, "/activity", this.querySelector("button"));
});
// A click anywhere on a row opens that pull request, the same page Enter
// opens. Links and the Review button keep their own click.
document.querySelectorAll("tr[data-href]").forEach(function(row) {
  row.addEventListener("click", function(event) {
    if (event.target.closest("a, button, input")) return;
    location.href = row.getAttribute("data-href");
  });
});
document.querySelectorAll("[data-review-pr]").forEach(function(btn) {
  btn.addEventListener("click", function() {
    postAndGo(${JSON.stringify(
      reviewBase,
    )} + btn.getAttribute("data-review-pr") + "/review", {}, "/activity", btn);
  });
});
</script>`,
    }),
  );
}
