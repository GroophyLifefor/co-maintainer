import {
  capped,
  empty,
  html,
  layout,
  money,
  repoNav,
  skSlot,
  text,
  when,
} from "./layout.ts";
import { COMPARE_FILE_CAP, MAX_COMMITS_COUNTED } from "../../services/drift.ts";
import type { repoOverview } from "../../services/dashboard.ts";

export function renderRepo(
  username: string,
  data: ReturnType<typeof repoOverview>,
): Response {
  const name = data.repo.full_name;
  const stats = data.stats;
  const drift = data.drift;
  const notice = drift &&
      (drift.prs_since > 0 || drift.prs_updated > 0 || drift.commits_since > 0)
    ? `<div class="notice" data-async>
      ${skSlot()}
      <div class="txt"><b>Update recommended.</b> Since the guide was built:
        ${drift.prs_since} new pull requests, ${drift.prs_updated} changed pull requests, ${
      capped(drift.commits_since, MAX_COMMITS_COUNTED)
    } commits, ${
      capped(drift.files_changed, COMPARE_FILE_CAP)
    } files changed.</div>
      <button class="btn primary" id="remake">Update now</button>
    </div>`
    : "";
  const pulls = data.recentPulls.length === 0
    ? empty(
      "No reviews yet",
      "Reviews appear here after a pull request is opened.",
    )
    : `<table>
          <thead><tr><th>Pull request</th><th>Reviewed</th><th class="num">Findings</th></tr></thead>
          <tbody>
            ${
      data.recentPulls.map((review) =>
        `<tr><td><a href="/repos/${
          text(name)
        }/pulls/${review.pr_number}">#${review.pr_number}</a></td>
              <td class="muted">${when(review.created_at)}</td>
              <td class="num">${review.findings_count}</td></tr>`
      ).join("")
    }
          </tbody>
        </table>`;
  const auto = data.repo.auto_review === 1;
  return html(layout({
    title: `${name} · co-maintainer`,
    username,
    body: `<div class="wrap side">
  ${repoNav(name, "overview")}
  <div>
    <div class="crumbs"><a href="/">Repositories</a> / ${text(name)}</div>
    <div class="pagehead">
      <div>
        <h1>${text(name)}</h1>
        <p class="lead">${
      auto ? "Reviewing pull requests automatically" : "Automatic review is off"
    } · knowledge ${
      data.repo.knowledge_built_at
        ? when(data.repo.knowledge_built_at)
        : "not built yet"
    }</p>
      </div>
      <div class="actions">
        <a class="btn" href="https://github.com/${
      text(name)
    }">Open on GitHub</a>
      </div>
    </div>
    ${notice}
    <div class="card">
      <div class="hd"><h2>Last 30 days</h2></div>
      <div class="bd">
        <div class="kfig">
          <div><div class="k">Pull requests reviewed</div><div class="big">${stats.pullRequests}</div></div>
          <div><div class="k">Findings</div><div class="big">${stats.findings}</div></div>
          <div><div class="k">Cost</div><div class="big">${
      money(stats.cost)
    }</div></div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="hd"><h2>Recent pull requests</h2>
        <a class="btn sm" style="margin-left:auto" href="/repos/${
      text(name)
    }/pulls">View all</a></div>
      <div class="bd flush">${pulls}</div>
    </div>
    <div class="card" data-async>
      ${skSlot()}
      <div class="hd"><h2>Automatic review</h2></div>
      <div class="bd">
        <div style="display:flex;align-items:center;gap:14px">
          <button class="tg${auto ? " on" : ""}" id="auto"></button>
          <div>
            <div><b>${auto ? "On" : "Off"}</b>. ${
      auto
        ? "Every new push to an open pull request gets reviewed."
        : "New pushes are not reviewed until you turn this on."
    }</div>
            <div class="hint" style="margin:2px 0 0">Drafts and bot pull requests follow the skip settings.
              <a href="/repos/${text(name)}/settings">Change</a></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
var repo = ${JSON.stringify(name)};
bindToggle(document.getElementById("auto"), "/api/repos/" + repo, "autoReview");
var remake = document.getElementById("remake");
if (remake) remake.addEventListener("click", function() {
  postAndGo("/api/repos/" + repo + "/remake", {}, "/activity", remake);
});
</script>`,
  }));
}
