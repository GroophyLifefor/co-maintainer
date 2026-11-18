import { empty, html, layout, text, when } from "./layout.ts";
import { repoHeader } from "./ui.ts";
import { formatCost } from "./cost.ts";
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
            <td class="num">${formatCost(review)}</td>
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
      active: "/",
      body: `<div class="wrap">
  ${repoHeader({
    fullName,
    tab: "remote",
    title: "Remote reviews",
    tabLabel: "Remote reviews",
    lead: "CLI reviews submitted from developer machines (last 30 days).",
  })}
  <div>
    <div class="card"><div class="bd flush">${rows}</div></div>
  </div>
</div>`,
    }),
  );
}
