import { html, layout, text } from "./layout.ts";

export function renderSetup(
  username: string,
  setup: { ai: boolean; github: boolean; app: boolean },
): Response {
  const row = (
    done: boolean,
    now: boolean,
    n: string,
    title: string,
    detail: string,
  ) =>
    `<li class="${done ? "done" : now ? "now" : ""}">
      <span class="n">${done ? "✓" : n}</span>
      <div class="body">
        <b>${title}</b>
        <span class="muted">${text(detail)}</span>
      </div>
      <a class="btn sm" href="/settings">Change</a>
    </li>`;
  const aiDetail = setup.ai
    ? "An AI provider and key are saved"
    : "Add a provider and API key in Settings";
  const ghDetail = setup.github
    ? "GitHub access is configured"
    : "Use gh or a personal access token";
  const appDetail = setup.app
    ? "The GitHub App is configured"
    : "Needed to post reviews on pull requests";
  return html(layout({
    title: "Get started · co-maintainer",
    username,
    body: `<div class="wrap" style="max-width:660px">
  <div class="pagehead">
    <div><h1>Get started</h1>
      <p class="lead">Two things now, then add your first repository.</p></div>
  </div>
  <div class="card"><div class="bd">
    <ul class="steps">
      ${row(setup.ai, !setup.ai, "1", "Models and API key", aiDetail)}
      ${
      row(
        setup.github,
        setup.ai && !setup.github,
        "2",
        "GitHub access",
        ghDetail,
      )
    }
      ${
      row(
        setup.app,
        setup.ai && setup.github && !setup.app,
        "3",
        "GitHub App",
        appDetail,
      )
    }
    </ul>
  </div></div>
  <p class="muted" style="font-size:13px">Ready? <a href="/repos/new">Add a repository</a>.</p>
</div>`,
  }));
}
