/** The Findings lists: one per repository (a repository tab) and one across
 * every repository (the left menu). Filters live in the URL query, so a
 * filtered list is a link any count on the dashboard can open. */
import {
  FINDING_SOURCES,
  type FindingSource,
} from "../../store/finding_list.ts";
import {
  empty,
  escapeHtml,
  html,
  layout,
  plural,
  text,
  when,
} from "./layout.ts";
import { icon, pageHeader, repoHeader, segmented, shortcutsBar } from "./ui.ts";
import {
  displayTitle,
  findingAnchor,
  locationLink,
  severityBadge,
  severityName,
  stateBadge,
} from "./finding_bits.ts";
import { SEVERITY_LEGEND } from "../../pr/review_copy.ts";
import { isBlocking, reviewBlockingFrom } from "../../review/blocking.ts";
import { readConfig } from "../../config.ts";
import type {
  FindingFilter,
  FindingListRow,
} from "../../store/finding_list.ts";

export const FINDINGS_PER_PAGE = 25;

/** What the URL asked for, each value checked. Anything that does not fit
 * is dropped, so a hand-edited link still shows a list. */
export type FindingQuery = {
  severity?: string;
  state: "open" | "closed" | "all";
  pr?: number;
  file?: string;
  q?: string;
  repo?: string;
  days?: number;
  /** The GitHub login that opened the pull request. */
  author?: string;
  /** Where the findings came from, see `FindingSource`. */
  source?: FindingSource;
  page: number;
};

export function parseFindingQuery(params: URLSearchParams): FindingQuery {
  const severity = params.get("severity") ?? "";
  const state = params.get("state");
  const pr = Number(params.get("pr") ?? "");
  const days = Number(params.get("days") ?? "");
  const page = Number(params.get("page") ?? 1);
  const trimmed = (name: string) => params.get(name)?.trim() || undefined;
  return {
    severity: SEVERITY_LEGEND.some((entry) => entry.level === severity)
      ? severity
      : undefined,
    state: state === "closed" || state === "all" ? state : "open",
    pr: Number.isSafeInteger(pr) && pr > 0 ? pr : undefined,
    file: trimmed("file"),
    q: trimmed("q"),
    repo: trimmed("repo"),
    days: [7, 30, 90].includes(days) ? days : undefined,
    author: trimmed("author")?.slice(0, 100),
    ...((FINDING_SOURCES as readonly string[]).includes(
      params.get("source") ?? "",
    )
      ? { source: params.get("source") as FindingSource }
      : {}),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

/** The store filter for a query. `repo` comes from the page for the
 * repository tab, from the query on the all-repositories list. */
export function findingFilter(
  query: FindingQuery,
  repo: string | undefined,
  daysAgoIso: (days: number) => string,
): FindingFilter {
  return {
    repo,
    severity: query.severity,
    state: query.state,
    pr: query.pr,
    file: query.file,
    q: query.q,
    sinceIso: query.days ? daysAgoIso(query.days) : undefined,
    author: query.author,
    source: query.source,
  };
}

/** The link to a findings list with some filters set, for the counts on
 * other pages. The state defaults to open, so a count of every finding
 * passes `state: "all"`. */
export function findingsHref(
  repo: string | undefined,
  filters: {
    severity?: string;
    state?: "open" | "closed" | "all";
    pr?: number;
    days?: number;
    author?: string;
  } = {},
): string {
  const params = new URLSearchParams();
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.state && filters.state !== "open") {
    params.set("state", filters.state);
  }
  if (filters.pr) params.set("pr", String(filters.pr));
  if (filters.days) params.set("days", String(filters.days));
  if (filters.author) params.set("author", filters.author);
  const base = repo ? `/repos/${repo}/findings` : "/findings";
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/** The same query with some values changed, as a link. The page goes back
 * to 1 unless it is the value being changed. */
function withQuery(
  base: string,
  query: FindingQuery,
  patch: Partial<Record<keyof FindingQuery, string | number | undefined>>,
): string {
  const values: Record<string, string | number | undefined> = {
    severity: query.severity,
    state: query.state === "open" ? undefined : query.state,
    pr: query.pr,
    file: query.file,
    q: query.q,
    repo: query.repo,
    days: query.days,
    author: query.author,
    source: query.source,
    page: undefined,
    ...patch,
  };
  if (values.state === "open") values.state = undefined;
  if (values.page === 1) values.page = undefined;
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(name, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${base}?${encoded}` : base;
}

function blockingLabel(
  row: FindingListRow,
  config: ReturnType<typeof readConfig>,
): string {
  const mode = reviewBlockingFrom(
    config.repos?.[row.repo]?.reviewBlocking ?? config.reviewBlocking,
  );
  return isBlocking(mode, { severity: row.severity, text: row.title })
    ? `<span class="st err nowrap">Blocking</span>`
    : `<span class="muted nowrap">Not blocking</span>`;
}

export function renderFindings(
  username: string,
  data: {
    /** Set on the repository tab, unset on the all-repositories list. */
    repo?: string;
    query: FindingQuery;
    items: FindingListRow[];
    total: number;
    /** The repositories to choose from on the all-repositories list. */
    repos: string[];
  },
): Response {
  const { query, repo } = data;
  const base = repo ? `/repos/${repo}/findings` : "/findings";
  const per = FINDINGS_PER_PAGE;
  const start = (query.page - 1) * per + 1;
  const end = Math.min(query.page * per, data.total);
  const severityChips = segmented([
    {
      label: "All",
      href: withQuery(base, query, { severity: undefined }),
      on: !query.severity,
    },
    ...SEVERITY_LEGEND.map((entry) => ({
      label: entry.name,
      href: withQuery(base, query, { severity: entry.level }),
      on: query.severity === entry.level,
    })),
  ]);
  const sourceChips = segmented(
    (
      [
        [undefined, "All reviews"],
        ["pr", "Pull requests"],
        ["push", "Pushes"],
        ["remote", "Remote"],
        ["cli", "CLI"],
        ["extension", "Extensions"],
      ] as const
    ).map(([source, label]) => ({
      label,
      href: withQuery(base, query, { source }),
      on: query.source === source,
    })),
  );
  const stateChips = segmented(
    (["open", "closed", "all"] as const).map((state) => ({
      label: state === "open" ? "Open" : state === "closed" ? "Closed" : "All",
      href: withQuery(base, query, { state }),
      on: query.state === state,
    })),
  );
  // The values a chip below the filters can take off again, one by one.
  const active: { label: string; drop: keyof FindingQuery }[] = [];
  if (!repo && query.repo) active.push({ label: query.repo, drop: "repo" });
  if (query.pr) active.push({ label: `PR #${query.pr}`, drop: "pr" });
  if (query.file) active.push({ label: `File: ${query.file}`, drop: "file" });
  if (query.q) active.push({ label: `Search: ${query.q}`, drop: "q" });
  if (query.days) {
    active.push({ label: `Last ${query.days} days`, drop: "days" });
  }
  if (query.author) {
    active.push({ label: `Author: ${query.author}`, drop: "author" });
  }
  const chips = active.length
    ? `<div class="chips">${active
        .map(
          (chip) =>
            `<a class="chip" href="${escapeHtml(
              withQuery(base, query, { [chip.drop]: undefined }),
            )}" aria-label="${escapeHtml(`Remove ${chip.label}`)}">${text(
              chip.label,
            )}${icon("circle-x")}</a>`,
        )
        .join("")}</div>`
    : "";
  const hidden = (["severity", "state", "days", "author", "source"] as const)
    .map((name) => {
      const value =
        name === "state" && query.state === "open" ? undefined : query[name];
      return value === undefined
        ? ""
        : `<input type="hidden" name="${name}" value="${escapeHtml(String(value))}">`;
    })
    .join("");
  const repoSelect = repo
    ? ""
    : `<select class="inp" name="repo" aria-label="Repository" style="width:auto">
        <option value="">All repositories</option>
        ${data.repos
          .map(
            (name) =>
              `<option value="${escapeHtml(name)}"${
                name === query.repo ? " selected" : ""
              }>${text(name)}</option>`,
          )
          .join("")}
      </select>`;
  const filters = `<form class="filters" method="get" action="${escapeHtml(base)}" role="search" id="findings-filters">
    <div class="sbox">${icon("search")}<input class="inp" type="search" name="q" value="${escapeHtml(
      query.q ?? "",
    )}" placeholder="Search titles and text" aria-label="Search titles and text" data-kb-search></div>
    <input class="inp" type="text" name="file" value="${escapeHtml(
      query.file ?? "",
    )}" placeholder="File" aria-label="File path contains" style="width:160px">
    <input class="inp" type="number" min="1" step="1" name="pr" value="${
      query.pr ?? ""
    }" placeholder="PR" aria-label="Pull request number" style="width:90px">
    ${repoSelect}
    ${hidden}
    <button type="submit" class="btn out sm">Filter</button>
  </form>
  <div class="filters">${severityChips}${stateChips}</div>
  <div class="filters">${sourceChips}</div>
  ${chips}`;
  // Read once for the page, not once per row.
  const config = readConfig();
  // A finding with no pull request opens the review that found it: the
  // Pushes tab for a push, the job page for a remote or CLI review.
  const prHref = (row: FindingListRow) =>
    row.pr_number !== null
      ? `/repos/${row.repo}/pulls/${row.pr_number}`
      : row.review_kind === "push"
        ? `/repos/${row.repo}/pushes`
        : `/activity/${row.job_id}`;
  const rows = data.items
    .map((row) => {
      const target = `${prHref(row)}#${findingAnchor(row.id)}`;
      const location = locationLink(row.repo, row.head_sha, row);
      return `<tr data-href="${escapeHtml(target)}" style="cursor:pointer">
        <td>${severityBadge(row.severity)}</td>
        <td>${blockingLabel(row, config)}</td>
        <td>${stateBadge(row.state, null)}</td>
        <td class="wrap"><a class="strong" href="${escapeHtml(target)}">${text(
          displayTitle(row.title),
        )}</a>${location ? `<span class="sub">${location}</span>` : ""}</td>
        <td class="wrap"><a href="${escapeHtml(prHref(row))}">${text(
          repo ? `#${row.pr_number}` : `${row.repo} #${row.pr_number}`,
        )}</a>${row.pr_title ? `<span class="sub">${text(row.pr_title)}</span>` : ""}</td>
        <td class="num">${row.round}</td>
        <td class="muted">${when(row.reviewed_at)}</td>
      </tr>`;
    })
    .join("");
  const filtered =
    Boolean(
      query.severity || query.pr || query.file || query.q || query.days,
    ) ||
    (!repo && Boolean(query.repo)) ||
    query.state !== "open";
  const table =
    data.items.length === 0
      ? empty(
          filtered ? "No findings match" : "No open findings",
          filtered
            ? "Try another filter, or take one off."
            : "Findings of reviewed pull requests show up here.",
          filtered
            ? `<a class="btn out sm" href="${escapeHtml(base)}">Clear filters</a>`
            : "",
        )
      : `<table class="fit" data-kb-list>
        <thead><tr><th>Severity</th><th>Blocking</th><th>State</th><th>Finding</th>
          <th>Pull request</th><th class="num">Round</th><th>When</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="pager"><span>${start}-${end} of ${data.total}</span><span class="sp"></span>
        ${
          query.page > 1
            ? `<a class="btn sm" href="${escapeHtml(
                withQuery(base, query, { page: query.page - 1 }),
              )}">Previous</a>`
            : `<button class="btn sm" disabled>Previous</button>`
        }
        ${
          end < data.total
            ? `<a class="btn sm" href="${escapeHtml(
                withQuery(base, query, { page: query.page + 1 }),
              )}">Next</a>`
            : `<button class="btn sm" disabled>Next</button>`
        }</div>`;
  const lead = `${plural(data.total, "finding")}${
    query.severity ? ` · ${severityName(query.severity).toLowerCase()}` : ""
  } · ${query.state === "all" ? "open and closed" : query.state}`;
  const head = repo
    ? repoHeader({
        fullName: repo,
        tab: "findings",
        title: "Findings",
        tabLabel: "Findings",
        lead,
      })
    : pageHeader({ title: "Findings", lead });
  return html(
    layout({
      title: repo ? `Findings · ${repo}` : "Findings · co-maintainer",
      username,
      active: repo ? "/" : "/findings",
      body: `<div class="wrap">
  ${head}
  ${filters}
  <div class="card"><div class="bd flush">${table}</div></div>
  ${data.items.length ? shortcutsBar() : ""}
</div>
<script>
document.querySelectorAll("tr[data-href]").forEach(function(row) {
  row.addEventListener("click", function(event) {
    if (event.target.closest("a")) return;
    location.href = row.getAttribute("data-href");
  });
});
</script>`,
    }),
  );
}
