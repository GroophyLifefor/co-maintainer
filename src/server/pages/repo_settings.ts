import { html, layout, repoNav, skSlot, text } from "./layout.ts";
import type { RepoRow } from "../../store/rows.ts";
import type { RepoConfig } from "../../config.ts";

export function renderRepoSettings(
  username: string,
  repo: RepoRow,
  config: RepoConfig,
): Response {
  const name = repo.full_name;
  const skip = repo.skip_drafts && repo.skip_bots
    ? "both"
    : repo.skip_drafts
    ? "drafts"
    : repo.skip_bots
    ? "bots"
    : "none";
  return html(layout({
    title: `Settings · ${name}`,
    username,
    body: `<div class="wrap side">
  ${repoNav(name, "settings")}
  <div>
    <div class="crumbs"><a href="/">Repositories</a> /
      <a href="/repos/${text(name)}">${text(name)}</a> / Settings</div>
    <div class="pagehead"><div><h1>Settings</h1></div></div>
    <div class="card" data-async>
      ${skSlot()}
      <div class="hd"><h2>Automatic review</h2></div>
      <div class="bd">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:22px">
          <button class="tg${
      repo.auto_review === 1 ? " on" : ""
    }" id="auto"></button>
          <div>Review pull requests as they are pushed</div>
        </div>
        <div class="field">
          <label>Skip</label>
          <select id="skip">
            <option value="both"${
      skip === "both" ? " selected" : ""
    }>Drafts and bot pull requests</option>
            <option value="drafts"${
      skip === "drafts" ? " selected" : ""
    }>Drafts only</option>
            <option value="bots"${
      skip === "bots" ? " selected" : ""
    }>Bots only</option>
            <option value="none"${
      skip === "none" ? " selected" : ""
    }>Nothing</option>
          </select>
        </div>
        <div class="field">
          <label>Review</label>
          <select id="scope">
            <option value="whole-pr"${
      repo.review_scope !== "incremental" ? " selected" : ""
    }>The whole pull request every time</option>
            <option value="incremental"${
      repo.review_scope === "incremental" ? " selected" : ""
    }>Only what changed since the last review</option>
          </select>
          <div class="hint">Reviewing only new changes costs less on long-running pull requests.</div>
        </div>
      </div>
      <div class="ft"><button class="primary" id="save-auto">Save</button></div>
    </div>
    <div class="card" data-async>
      ${skSlot()}
      <div class="hd"><h2>How this repository is analyzed</h2></div>
      <div class="bd">
        <p class="muted" style="margin:0 0 18px">Used when the knowledge is rebuilt. Leave blank to use your account defaults.</p>
        <div class="two">
          <div class="field"><label>Months of pull requests</label>
            <input id="months" value="${text(config.maxPrMonths ?? "")}"></div>
          <div class="field"><label>Commits</label>
            <input id="commits" value="${text(config.maxCommits ?? "")}"></div>
          <div class="field"><label>Max lines per pull request</label>
            <input id="lines" value="${
      text(config.maxPullRequestChangeLines ?? "")
    }"></div>
          <div class="field"><label>Max comments per pull request</label>
            <input id="comments" value="${
      text(config.maxComments ?? "")
    }"></div>
        </div>
      </div>
      <div class="ft"><button class="primary" id="save-init">Save</button></div>
    </div>
    <div class="card" data-async>
      ${skSlot()}
      <div class="hd"><h2>Remove</h2></div>
      <div class="bd" style="display:flex;align-items:center;gap:16px">
        <div class="txt">Stop reviewing this repository. Review history is kept.</div>
        <button id="remove" style="margin-left:auto;color:var(--red)">Remove repository</button>
      </div>
    </div>
  </div>
</div>
<script>
var repo = ${JSON.stringify(name)};
function save(btn, body) {
  run(btn, btn.closest("[data-async]"), async function() {
    await api("PATCH", "/api/repos/" + repo, body);
    location.reload();
  });
}
document.getElementById("save-auto").addEventListener("click", function() {
  var skip = document.getElementById("skip").value;
  save(this, {
    autoReview: document.getElementById("auto").classList.contains("on"),
    skipDrafts: skip === "both" || skip === "drafts",
    skipBots: skip === "both" || skip === "bots",
    reviewScope: document.getElementById("scope").value
  });
});
document.getElementById("auto").addEventListener("click", function() {
  this.classList.toggle("on");
});
document.getElementById("save-init").addEventListener("click", function() {
  var num = function(id) {
    var v = document.getElementById(id).value.trim();
    return v === "" ? null : Number(v);
  };
  save(this, {
    maxPrMonths: num("months"),
    maxCommits: num("commits"),
    maxPullRequestChangeLines: num("lines"),
    maxComments: num("comments")
  });
});
document.getElementById("remove").addEventListener("click", function() {
  if (!confirm("Stop reviewing this repository?")) return;
  var btn = this;
  run(btn, btn.closest("[data-async]"), async function() {
    await api("DELETE", "/api/repos/" + repo);
    location.href = "/";
  });
});
</script>`,
  }));
}
