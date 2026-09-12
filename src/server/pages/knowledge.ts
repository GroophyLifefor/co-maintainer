import { empty, html, layout, repoNav, skSlot, text, when } from "./layout.ts";
import type { repoKnowledge } from "../../services/dashboard.ts";

/** A compare response stops listing files at 300, so that figure is a
 * floor rather than a count. */
function fileCount(files: number): string {
  return files >= 300 ? "300+" : String(files);
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function renderKnowledge(
  username: string,
  data: Awaited<ReturnType<typeof repoKnowledge>>,
  viewId?: string,
): Response {
  const name = data.repo.full_name;
  const viewing = data.docs.find((doc) => doc.id === viewId);
  const drift = data.drift;
  const notice = data.repo.knowledge_built_at
    ? `<div class="notice"><div class="txt">Built ${
      when(data.repo.knowledge_built_at)
    }.${
      drift
        ? ` Since then: <b>${drift.prs_since} new pull requests</b>, <b>${drift.prs_updated} changed pull requests</b>, <b>${drift.commits_since} new commits</b> and <b>${
          fileCount(drift.files_changed)
        } changed files</b>. <span class="muted">Checked ${
          when(drift.as_of)
        }.</span>`
        : ""
    }</div></div>`
    : `<div class="notice info"><div class="txt">Knowledge has not been built yet. Run init from the repository list.</div></div>`;
  const viewer = viewing
    ? `<div class="card"><div class="hd"><h2>${text(viewing.title)}</h2>
        <a class="btn sm" style="margin-left:auto" href="/repos/${
      text(name)
    }/knowledge">Close</a></div>
      <div class="bd"><pre class="log" style="max-height:none">${
      text(viewing.text)
    }</pre></div></div>`
    : "";
  const table = data.docs.length === 0
    ? empty(
      "No documents",
      "Init this repository to generate the review guide.",
    )
    : `<table>
          <thead><tr><th>Document</th><th>What it covers</th><th class="num">Size</th><th></th></tr></thead>
          <tbody>
            ${
      data.docs.map((doc) =>
        `<tr><td><b>${text(doc.title)}</b></td>
              <td class="muted">${text(doc.covers)}</td>
              <td class="num">${text(sizeLabel(doc.bytes))}</td>
              <td style="width:1%"><a class="btn sm" href="?view=${
          text(doc.id)
        }">View</a></td></tr>`
      ).join("")
    }
          </tbody>
        </table>`;
  return html(layout({
    title: `Knowledge · ${name}`,
    username,
    body: `<div class="wrap side">
  ${repoNav(name, "knowledge")}
  <div data-async>
    ${skSlot()}
    <div class="crumbs"><a href="/">Repositories</a> /
      <a href="/repos/${text(name)}">${text(name)}</a> / Knowledge</div>
    <div class="pagehead">
      <div><h1>Knowledge</h1>
        <p class="lead">What co-maintainer learned about this repository, and checks every pull request against.</p></div>
      <div class="actions"><button class="primary" id="update">Update</button></div>
    </div>
    ${notice}
    <div class="card"><div class="bd flush">${table}</div></div>
    ${viewer}
    <div class="card">
      <div class="hd"><h2>History</h2></div>
      <div class="bd">${
      empty(
        "Only the current knowledge is kept",
        "Older versions are not stored yet.",
      )
    }</div>
    </div>
  </div>
</div>
<script>
document.getElementById("update").addEventListener("click", function() {
  postAndGo("/api/repos/" + ${
      JSON.stringify(name)
    } + "/remake", {}, "/activity", this);
});
</script>`,
  }));
}
