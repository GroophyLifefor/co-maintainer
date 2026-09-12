import {
  empty,
  html,
  layout,
  markdown,
  money,
  repoNav,
  skSlot,
  text,
  when,
} from "./layout.ts";
import type { prDetail } from "../../services/dashboard.ts";

export function renderPr(
  username: string,
  fullName: string,
  data: ReturnType<typeof prDetail>,
): Response {
  const n = data.prNumber;
  const totalCost = data.reviews.reduce(
    (sum, review) => sum + Number(review.cost ?? 0),
    0,
  );
  const findingList = (
    findings: typeof data.reviews[number]["findings"],
  ) =>
    findings.length === 0
      ? empty("No findings", "This review did not report anything to fix.")
      : findings.map((finding, index) =>
        `<div${
          index < findings.length - 1
            ? ` style="padding-bottom:18px;border-bottom:1px solid var(--border2);margin-bottom:18px"`
            : ""
        }>
          <div style="margin-bottom:6px"><b>${text(finding.title)}</b>${
          finding.first_seen_review_id
            ? ` <span class="muted" style="font-size:13px">Seen in an earlier round</span>`
            : ""
        }</div>
          <div class="mono muted" style="font-size:13px;margin-bottom:8px">${
          text(
            finding.path ? `${finding.path}:${finding.line_from ?? ""}` : "",
          )
        }</div>
          ${markdown(finding.body_md)}
        </div>`
      ).join("");
  const findingsBlock = data.reviews.length === 0
    ? empty(
      "No findings",
      "Run a review to post findings on this pull request.",
    )
    : data.reviews.map((review, index) =>
      `<details${index === 0 ? " open" : ""} style="padding:14px 0${
        index < data.reviews.length - 1
          ? ";border-bottom:1px solid var(--border2)"
          : ""
      }">
        <summary style="cursor:pointer">
          <b>Round ${text(review.round)}</b>
          <span class="muted"> · ${
        text(review.head_sha.slice(0, 7))
      } · ${review.findings.length} finding${
        review.findings.length === 1 ? "" : "s"
      }</span>
        </summary>
        <div style="padding:16px 4px 4px">${findingList(review.findings)}</div>
      </details>`
    ).join("");
  const reviewsTable = data.reviews.length === 0
    ? empty(
      "Not reviewed yet",
      "Run a review to post findings on this pull request.",
    )
    : `<table>
          <thead><tr><th>Round</th><th>When</th><th>Commit</th><th>Looked at</th>
            <th class="num">Findings</th><th class="num">Cost</th></tr></thead>
          <tbody>
            ${
      data.reviews.map((review) =>
        `<tr><td>${text(review.round)}</td>
              <td>${when(review.created_at)}</td>
              <td class="mono">${text(review.head_sha.slice(0, 7))}</td>
              <td class="muted">${
          text(
            review.scope === "incremental"
              ? "Changes since the last review"
              : "Whole pull request",
          )
        }</td>
              <td class="num">${review.findings_count}</td>
              <td class="num">${money(Number(review.cost ?? 0))}</td></tr>`
      ).join("")
    }
          </tbody>
        </table>`;
  return html(layout({
    title: `#${n} · co-maintainer`,
    username,
    body: `<div class="wrap side">
  ${repoNav(fullName, "pulls")}
  <div data-async>
    ${skSlot()}
    <div class="crumbs"><a href="/">Repositories</a> /
      <a href="/repos/${text(fullName)}">${text(fullName)}</a> /
      <a href="/repos/${text(fullName)}/pulls">Pull requests</a> / #${n}</div>
    <div class="pagehead">
      <div>
        <h1>#${n}</h1>
        <p class="lead">${data.reviews.length} review${
      data.reviews.length === 1 ? "" : "s"
    } on record</p>
      </div>
      <div class="actions">
        <button id="again">Review again</button>
        <a class="btn" href="https://github.com/${
      text(fullName)
    }/pull/${n}">Open on GitHub</a>
      </div>
    </div>
    <div class="card">
      <div class="hd"><h2>Findings</h2>
        <span class="muted" style="margin-left:auto;font-size:13px">${
      data.reviews.reduce((sum, review) => sum + review.findings.length, 0)
    } findings across ${data.reviews.length} review${
      data.reviews.length === 1 ? "" : "s"
    }</span></div>
      <div class="bd">${findingsBlock}</div>
    </div>
    <div class="card">
      <div class="hd"><h2>Reviews</h2>
        <span class="muted" style="margin-left:auto;font-size:13px">${
      money(totalCost)
    } total</span></div>
      <div class="bd flush">${reviewsTable}</div>
    </div>
  </div>
</div>
<script>
document.getElementById("again").addEventListener("click", function() {
  postAndGo("/api/repos/" + ${
      JSON.stringify(fullName)
    } + "/pulls/${n}/review", {}, "/activity", this);
});
</script>`,
  }));
}
