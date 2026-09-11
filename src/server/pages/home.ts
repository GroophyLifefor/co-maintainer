import { empty, html, layout, skSlot, text, when } from "./layout.ts";

export function renderLogin(opts: { next: string; error?: string }): Response {
  const err = opts.error
    ? `<p class="notice bad"><span class="txt">${text(opts.error)}</span></p>`
    : "";
  return html(layout({
    title: "Sign in · co-maintainer",
    body: `<div class="wrap" style="max-width:420px">
  <img class="brand" src="/logo.png" alt="co-maintainer">
  <div class="pagehead"><div><h1>Sign in</h1>
    <p class="lead">Use the dashboard password printed when serve started.</p></div></div>
  ${err}
  <div class="card"><div class="bd">
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${text(opts.next)}">
      <div class="field wide"><label>Password</label>
        <input type="password" name="password" autofocus required></div>
      <button class="primary" type="submit">Sign in</button>
    </form>
  </div></div>
</div>`,
  }));
}

export function renderHome(
  username: string,
  rows: {
    fullName: string;
    statusKind: "ok" | "warn" | "err" | "run";
    status: string;
    knowledge: string;
    knowledgeAt?: string;
    autoOn: boolean;
    reviews: string;
    cost: string;
  }[],
): Response {
  const autoCount = rows.filter((row) => row.autoOn).length;
  const lead = rows.length === 0
    ? "No repositories yet. Add one to start."
    : `${rows.length} repositories · ${autoCount} reviewing pull requests automatically`;
  const body = rows.length === 0
    ? empty(
      "No repositories",
      "Add a repository to generate knowledge and review pull requests.",
    )
    : `<div class="card" data-async>
    ${skSlot("table")}
    <div class="bd flush">
      <table>
        <thead><tr>
          <th>Repository</th><th>Status</th><th>Knowledge</th><th>Auto review</th>
          <th class="num">Reviews</th><th class="num">Cost (30d)</th>
        </tr></thead>
        <tbody>
          ${
      rows.map((row) =>
        `<tr>
            <td><a href="/repos/${text(row.fullName)}">${
          text(row.fullName)
        }</a></td>
            <td><span class="st ${row.statusKind}">${
          text(row.status)
        }</span></td>
            <td>${text(row.knowledge)}${
          row.knowledgeAt
            ? `<div class="dim" style="font-size:13px">${
              when(row.knowledgeAt)
            }</div>`
            : ""
        }</td>
            <td>${
          row.autoOn
            ? `<button class="tg on" data-repo="${
              text(row.fullName)
            }" data-on="1"></button>`
            : `<button class="tg" data-repo="${
              text(row.fullName)
            }" data-on="0"></button>`
        }</td>
            <td class="num">${text(row.reviews)}</td>
            <td class="num">${text(row.cost)}</td>
          </tr>`
      ).join("")
    }
        </tbody>
      </table>
    </div>
    <div class="ft"><span>Showing ${rows.length} repositories</span></div>
  </div>`;
  return html(layout({
    title: "Repositories · co-maintainer",
    username,
    body: `<div class="wrap">
  <div class="pagehead">
    <div><h1>Repositories</h1><p class="lead">${text(lead)}</p></div>
    <div class="actions"><a class="btn primary" href="/repos/new">Add repository</a></div>
  </div>
  ${body}
</div>
<script>
document.querySelectorAll(".tg[data-repo]").forEach(function(btn) {
  bindToggle(btn, "/api/repos/" + btn.getAttribute("data-repo"), "autoReview");
});
</script>`,
  }));
}
