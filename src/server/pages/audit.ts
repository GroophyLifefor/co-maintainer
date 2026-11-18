/** Settings > Audit log: who did what on this server, and when. Filters by
 * kind and person live in the URL, like every other list. */
import { empty, escapeHtml, html, layout, text, when } from "./layout.ts";
import { pageHeader } from "./ui.ts";
import {
  AUDIT_KINDS,
  type AuditKind,
  type AuditRow,
} from "../../store/audit.ts";

export const AUDIT_PER_PAGE = 50;

export const AUDIT_KIND_WORDS: Record<AuditKind, string> = {
  settings: "Settings",
  "repo-settings": "Repository settings",
  token: "Remote tokens",
  repo: "Repositories",
  "sign-in": "Sign-ins",
  review: "Reviews started",
  dismiss: "Dismissed failures",
  update: "Updates",
};

export type AuditQuery = { kind?: AuditKind; actor?: string; page: number };

export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  const kind = params.get("kind") ?? "";
  const page = Number(params.get("page") ?? 1);
  return {
    kind: (AUDIT_KINDS as string[]).includes(kind)
      ? (kind as AuditKind)
      : undefined,
    actor: params.get("actor")?.trim().slice(0, 100) || undefined,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

function auditHref(query: AuditQuery, page = 1): string {
  const params = new URLSearchParams();
  if (query.kind) params.set("kind", query.kind);
  if (query.actor) params.set("actor", query.actor);
  if (page > 1) params.set("page", String(page));
  const encoded = params.toString();
  return encoded ? `/settings/audit?${encoded}` : "/settings/audit";
}

function changesCell(row: AuditRow): string {
  if (row.changes.length === 0) return "";
  return `<ul class="audit-changes">${row.changes
    .map(
      (change) =>
        `<li><span class="mono">${text(change.setting)}</span>: ${text(
          change.from,
        )} to ${text(change.to)}</li>`,
    )
    .join("")}</ul>`;
}

export function renderAudit(
  username: string,
  query: AuditQuery,
  data: { items: AuditRow[]; total: number; actors: string[] },
): Response {
  const per = AUDIT_PER_PAGE;
  const start = (query.page - 1) * per + 1;
  const end = Math.min(query.page * per, data.total);
  const select = (
    name: string,
    label: string,
    all: string,
    options: { value: string; label: string }[],
    current: string | undefined,
  ) =>
    `<select class="inp" name="${name}" aria-label="${label}" style="width:auto" data-audit-filter>
      <option value="">${all}</option>
      ${options
        .map(
          (option) =>
            `<option value="${escapeHtml(option.value)}"${
              option.value === current ? " selected" : ""
            }>${text(option.label)}</option>`,
        )
        .join("")}
    </select>`;
  const filters = `<form class="filters" method="get" action="/settings/audit" id="audit-filters">
    ${select(
      "kind",
      "Kind",
      "Every kind",
      AUDIT_KINDS.map((kind) => ({
        value: kind,
        label: AUDIT_KIND_WORDS[kind],
      })),
      query.kind,
    )}
    ${select(
      "actor",
      "Person",
      "Everyone",
      data.actors.map((actor) => ({ value: actor, label: actor })),
      query.actor,
    )}
    <noscript><button type="submit" class="btn out sm">Filter</button></noscript>
    ${
      query.kind || query.actor
        ? `<a class="btn out sm" href="/settings/audit">Show all</a>`
        : ""
    }
  </form>`;
  const table =
    data.items.length === 0
      ? empty(
          query.kind || query.actor
            ? "Nothing fits this filter"
            : "Nothing yet",
          query.kind || query.actor
            ? "Try another kind or person."
            : "Settings changes, tokens, repositories, sign-ins, reviews started, dismissed failures and updates show up here.",
        )
      : `<table>
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Changes</th></tr></thead>
        <tbody>
          ${data.items
            .map(
              (row) => `<tr>
            <td class="muted">${when(row.at)}</td>
            <td>${text(row.actor)}</td>
            <td class="wrap">${text(row.summary)}${
              row.target ? `<span class="sub">${text(row.target)}</span>` : ""
            }<span class="sub">${text(AUDIT_KIND_WORDS[row.kind] ?? row.kind)}</span></td>
            <td class="wrap">${changesCell(row)}</td>
          </tr>`,
            )
            .join("")}
        </tbody>
      </table>
      <div class="pager"><span>${start}-${end} of ${data.total}</span><span class="sp"></span>
        ${
          query.page > 1
            ? `<a class="btn sm" href="${escapeHtml(auditHref(query, query.page - 1))}">Previous</a>`
            : `<button class="btn sm" disabled>Previous</button>`
        }
        ${
          end < data.total
            ? `<a class="btn sm" href="${escapeHtml(auditHref(query, query.page + 1))}">Next</a>`
            : `<button class="btn sm" disabled>Next</button>`
        }
      </div>`;
  return html(
    layout({
      title: "Audit log · co-maintainer",
      username,
      active: "/settings/audit",
      body: `<div class="wrap">
  ${pageHeader({
    title: "Audit log",
    lead: "Who did what on this server, and when. Secrets are never shown.",
  })}
  ${filters}
  <div class="card" id="audit"><div class="bd flush">${table}</div></div>
</div>
<script>
document.querySelectorAll("[data-audit-filter]").forEach(function(select) {
  select.addEventListener("change", function() {
    select.form.submit();
  });
});
</script>`,
    }),
  );
}
