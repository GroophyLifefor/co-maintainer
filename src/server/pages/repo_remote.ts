import { empty, html, layout, money, repoNav, text, when } from "./layout.ts";
import type { repoRemoteReviews } from "../../services/dashboard.ts";

export function renderRepoRemote(
  username: string,
  fullName: string,
  data: ReturnType<typeof repoRemoteReviews>,
): Response {
  const rows =
    data.items.length === 0
      ? empty(
          "No remote reviews yet",
          "Developers run co-maintainer review --remote with a token from Settings.",
        )
      : `<table>
        <thead><tr><th>Branch</th><th>Token</th><th>Status</th><th class="num">Findings</th>
          <th class="num">Cost</th><th>When</th></tr></thead>
        <tbody>
          ${data.items
            .map(
              (review) =>
                `<tr>
            <td>${text(review.branch ?? "none")}</td>
            <td>${text(review.token_name ?? "none")}</td>
            <td>${text(review.status)}</td>
            <td class="num">${review.findings_count ?? 0}</td>
            <td class="num">${money(review.cost ?? 0)}</td>
            <td class="muted">${when(review.created_at)}</td>
          </tr>`,
            )
            .join("")}
        </tbody>
      </table>`;
  return html(
    layout({
      title: `${fullName} · Remote · co-maintainer`,
      username,
      body: `<div class="wrap side">
  ${repoNav(fullName, "remote")}
  <div>
    <div class="crumbs"><a href="/">Repositories</a> / ${text(fullName)}</div>
    <div class="pagehead">
      <div>
        <h1>Remote reviews</h1>
        <p class="lead">CLI reviews submitted from developer machines (last 30 days).</p>
      </div>
    </div>
    <div class="card"><div class="bd flush">${rows}</div></div>
  </div>
</div>`,
    }),
  );
}
