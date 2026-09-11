import { html, layout, skSlot, text } from "./layout.ts";

export type RepoChoice = {
  fullName: string;
  account: string;
  alreadyActive: boolean;
};

export function renderAddRepo(
  username: string,
  picker: { repos: RepoChoice[]; error?: string },
): Response {
  const notice = picker.error
    ? `<div class="notice bad"><div class="txt">${
      text(picker.error)
    }</div></div>`
    : "";
  const groups = new Map<string, RepoChoice[]>();
  for (const repo of picker.repos) {
    const list = groups.get(repo.account) ?? [];
    list.push(repo);
    groups.set(repo.account, list);
  }
  const options = [...groups.entries()].map(([account, repos]) =>
    `<optgroup label="${text(account)}">${
      repos.map((repo) =>
        `<option value="${text(repo.fullName)}"${
          repo.alreadyActive ? " disabled" : ""
        }>${text(repo.fullName)}${
          repo.alreadyActive ? " (already added)" : ""
        }</option>`
      ).join("")
    }</optgroup>`
  ).join("");
  const canAdd = picker.repos.some((repo) => !repo.alreadyActive);
  const select = `<select id="repo"${canAdd ? "" : " disabled"}>
          <option value="">Choose a repository</option>
          ${options}
        </select>`;
  return html(layout({
    title: "Add repository · co-maintainer",
    username,
    body: `<div class="wrap" style="max-width:760px">
  <div class="crumbs"><a href="/">Repositories</a> / Add</div>
  <div class="pagehead">
    <div><h1>Add repository</h1>
      <p class="lead">Pick a repository this App can access.</p></div>
  </div>
  ${notice}
  <div class="card" data-async>
    ${skSlot()}
    <div class="bd">
    <div class="field wide" style="display:flex;gap:10px;align-items:flex-end;margin:0">
      <div style="flex:1">
        <label>Repository</label>
        ${select}
      </div>
      <button class="primary" id="add"${
      canAdd ? "" : " disabled"
    }>Add repository</button>
    </div>
  </div></div>
</div>
<script>
document.getElementById("add").addEventListener("click", function() {
  var btn = this;
  var repo = document.getElementById("repo").value.trim();
  if (!repo) return;
  run(btn, btn.closest("[data-async]"), async function() {
    await api("POST", "/api/repos", { repo: repo });
    location.href = "/activity";
  });
});
</script>`,
  }));
}
