import { html, layout, text } from "./layout.ts";
import type { SetupItem } from "../../services/setup_checklist.ts";

export function renderSetup(username: string, checklist: SetupItem[]): Response {
  const doneCount = checklist.filter((item) => item.done).length;
  const allDone = doneCount === checklist.length;
  // The first unfinished step is the current one.
  const current = checklist.findIndex((item) => !item.done);
  const rows = checklist
    .map(
      (item, index) =>
        `<li class="${item.done ? "done" : index === current ? "now" : ""}">
      <span class="n">${item.done ? "✓" : index + 1}</span>
      <div class="body">
        <b>${text(item.title)}</b>
        <span class="muted">${text(item.detail)}</span>
      </div>
      <a class="btn sm" href="${item.href}">${item.done ? "Change" : text(item.linkLabel)}</a>
    </li>`,
    )
    .join("");
  return html(
    layout({
      title: "Get started · co-maintainer",
      username,
      active: "/setup",
      body: `<div class="wrap narrow">
  <div class="pagehead">
    <div><h1>${allDone ? "All set" : "Get started"}</h1>
      <p class="lead">${doneCount} of ${checklist.length} done</p></div>
  </div>
  <div class="card"><div class="bd">
    <ul class="steps">
      ${rows}
    </ul>
  </div></div>
  <p class="muted" style="font-size:13px">${
    allDone
      ? "Every required step is done. Change any of them above."
      : 'Ready? <a href="/repos/new">Add a repository</a>.'
  }</p>
</div>`,
    }),
  );
}
