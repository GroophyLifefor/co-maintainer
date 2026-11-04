import { empty, html, layout, layoutFocus, skSlot, text, when } from "./layout.ts";
import type { SetupItem } from "../../services/setup_checklist.ts";
import { alert, badge, icon, segmented } from "./ui.ts";
import type { RepoState } from "../../services/repo_list.ts";

const STATE_BADGE: Record<RepoState, string> = {
  reviewing: badge("emerald", "Reviewing", { icon: "circle-check" }),
  paused: badge("neutral", "Paused", { icon: "circle-pause" }),
  "setting-up": badge("sky", "Setting up", { icon: "loader" }),
  "setup-failed": badge("red", "Setup failed", { icon: "circle-alert" }),
};

export function renderLogin(opts: {
  next: string;
  error?: string;
  showPassword: boolean;
  showGithub: boolean;
  /** `CM_LOGIN_HINT`, for a deployment that hands out its own password (the
   * Cloud image seeds one), so this page can point at it instead of the
   * generic "printed when serve started". Falls back to the default line. */
  hint?: string;
}): Response {
  const err = opts.error
    ? `<p class="notice bad"><span class="txt">${text(opts.error)}</span></p>`
    : "";
  const passwordForm = opts.showPassword
    ? `<form method="post" action="/login">
      <input type="hidden" name="next" value="${text(opts.next)}">
      <div class="field wide"><label>Password</label>
        <input type="password" name="password" autofocus required></div>
      <button class="primary" type="submit">Sign in</button>
    </form>`
    : "";
  const githubButton = opts.showGithub
    ? `<a class="btn primary" style="display:block;text-align:center" href="/auth/github?next=${encodeURIComponent(
        opts.next,
      )}">Continue with GitHub</a>`
    : "";
  const divider =
    opts.showPassword && opts.showGithub
      ? `<p class="muted" style="text-align:center;margin:16px 0">or</p>`
      : "";
  const lead = opts.showPassword
    ? opts.hint?.trim() ||
      "Use the dashboard password printed when serve started."
    : "Sign in with your GitHub account.";
  return html(
    layoutFocus({
      title: "Sign in · co-maintainer",
      body: `<img class="brand" src="/logo.png" alt="co-maintainer">
  <div class="pagehead"><div><h1>Sign in</h1>
    <p class="lead">${text(lead)}</p></div></div>
  ${err}
  <div class="card"><div class="bd">
    ${passwordForm}${divider}${githubButton}
  </div></div>`,
    }),
  );
}

export function renderHome(
  username: string,
  rows: {
    fullName: string;
    state: RepoState;
    autoOn: boolean;
    fromCli?: boolean;
    knowledge: string;
    knowledgeAt?: string;
    reviews: string;
    failed: number;
    cost: string;
  }[],
  checklist: SetupItem[],
  /** `rows` is already filtered; `total` and `reviewing` count every
   * repository so the lead and the tabs do not shrink with the filter. */
  filter: { q: string; status: string; total: number; reviewing: number },
): Response {
  const lead =
    filter.total === 0
      ? "No repositories yet. Add one to start."
      : `${filter.total} repositories · ${filter.reviewing} reviewing pull requests automatically`;
  const remaining = checklist.filter((item) => !item.done);
  // One compact banner pointing at /setup, where the steps live. It is
  // hidden entirely once everything is done, so a finished install is not
  // told to "finish" anything.
  const setupCard =
    remaining.length === 0
      ? ""
      : `<div id="finish-setup">${alert("amber", {
          title: "Setup is not finished",
          body: `${checklist.length - remaining.length}/${checklist.length} done · ${text(
            remaining[0]!.detail,
          )}`,
          icon: "list-checks",
          action: `<a class="btn out sm" href="/setup">Continue${icon("arrow-right", "arr")}</a>`,
        })}</div>`;
  // Tabs keep the search and the search keeps the tab, so both filters
  // combine without JS.
  const tabHref = (status: string) => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (filter.q) params.set("q", filter.q);
    const query = params.toString();
    return query ? `/?${query}` : "/";
  };
  const current = filter.status === "reviewing" || filter.status === "paused"
    ? filter.status
    : "all";
  const filters = `<div class="filters">
    <form class="sbox" method="get" action="/" role="search">${icon("search")}<input class="inp" type="search" name="q" value="${text(
      filter.q,
    )}" placeholder="Search repositories" aria-label="Search repositories">${
      current === "all" ? "" : `<input type="hidden" name="status" value="${current}">`
    }</form>
    ${segmented([
      { label: "All", href: tabHref("all"), on: current === "all" },
      { label: "Reviewing", icon: "circle-check", href: tabHref("reviewing"), on: current === "reviewing" },
      { label: "Paused", icon: "circle-pause", href: tabHref("paused"), on: current === "paused" },
    ])}
  </div>`;
  const body =
    filter.total === 0
      ? empty(
          "No repositories",
          "Add a repository to generate knowledge and review pull requests.",
        )
      : rows.length === 0
        ? `${filters}${empty("No repositories match", "Try another search or tab.")}`
        : `${filters}<div class="card" data-async>
    ${skSlot("table")}
    <div class="bd flush">
      <table>
        <thead><tr>
          <th>Repository</th><th>Status</th><th>Knowledge</th>
          <th class="num">Reviews (30d)</th><th class="num">Cost (30d)</th><th></th>
        </tr></thead>
        <tbody>
          ${rows
            .map(
              (row) =>
                `<tr>
            <td><a class="strong" href="/repos/${text(row.fullName)}">${text(row.fullName)}</a><span class="sub">${
              row.fromCli
                ? "Added from CLI"
                : row.autoOn
                  ? "Automatic review on"
                  : "Automatic review off"
            }</span></td>
            <td>${STATE_BADGE[row.state]}</td>
            <td>${text(row.knowledge)}${
              row.knowledgeAt
                ? `<div class="dim" style="font-size:13px">${when(row.knowledgeAt)}</div>`
                : ""
            }</td>
            <td class="num">${text(row.reviews)}${
              row.failed > 0 ? `<span class="sub">${row.failed} failed</span>` : ""
            }</td>
            <td class="num">${text(row.cost)}</td>
            <td class="num"><a class="btn out sm" href="/repos/${text(row.fullName)}">Open${icon(
              "arrow-right",
              "arr",
            )}</a></td>
          </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <div class="ft"><span>Showing ${rows.length} of ${filter.total} repositories</span></div>
  </div>`;
  return html(
    layout({
      title: "Repositories · co-maintainer",
      username,
      active: "/",
      body: `<div class="wrap">
  <div class="pagehead">
    <div><h1>Repositories</h1><p class="lead">${text(lead)}</p></div>
    <div class="actions">${
      rows.length === 0 ? `<a class="btn" href="/setup">Get started</a>` : ""
    }<a class="btn primary" href="/repos/new">${icon("plus")}Add repository</a></div>
  </div>
  ${setupCard}
  ${body}
</div>`,
    }),
  );
}
