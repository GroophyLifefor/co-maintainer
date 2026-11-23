/** The pull request half of probe: how many there are, per year and per
 * window, and a sample with line counts. One GraphQL query of aliased
 * searches answers all of it. When GraphQL fails, the REST listing of every
 * pull request answers it as before, and the sample's details come from one
 * REST call each. */
import { graphql, graphqlOr } from "../github/graphql.ts";
import { withinPrWindow } from "../github/collect.ts";
import { pullCountsFromList, type PullCounts } from "../knowledge/probe.ts";
import type { GitHubClient, Json } from "../types.ts";

/** Samples this many pull requests for diff sizes, on top of a few per year. */
export const SAMPLE_HEAD = 30;
export const SAMPLE_PER_YEAR = 3;

/** The windows the estimate prices: the shorter ones `fasterOption` tries,
 * and every whole number of years, which is what a recommendation can be. */
export function windowMonths(years: number): number[] {
  const months = new Set([3, 6, 12, 24]);
  for (let n = 1; n <= years; n++) months.add(n * 12);
  return [...months].sort((a, b) => a - b);
}

export type ProbePulls = {
  counts: PullCounts;
  /** Pull requests updated in the last N months, by N. */
  windows: Record<number, number>;
  /** The sample with line counts, when GraphQL read them. */
  details?: Json[];
  /** The sample still to read one by one, after a REST listing. */
  targets?: Json[];
  /** Every listed `updated_at`, after a REST listing. */
  updatedAt?: string[];
};

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The day `withinPrWindow` cuts at, as a search date. */
function windowStart(months: number): string {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return isoDay(cutoff);
}

const PULL_FIELDS = `number additions deletions isDraft updatedAt author { login __typename }`;

/** A GraphQL pull request in the shape of the REST detail probe reads. */
export function restShape(node: Json): Json {
  const author = (node.author ?? {}) as Json;
  return {
    number: Number(node.number),
    additions: Number(node.additions ?? 0),
    deletions: Number(node.deletions ?? 0),
    draft: node.isDraft === true,
    updated_at: String(node.updatedAt ?? ""),
    user: {
      login: String(author.login ?? ""),
      type: author.__typename === "Bot" ? "Bot" : "User",
    },
  };
}

/** The one query: the total and the newest sample, each year's count and
 * its newest few, and each window's count. */
export function countsQuery(
  repo: string,
  firstYear: number,
  currentYear: number,
): string {
  const base = `repo:${repo} is:pr`;
  const search = (alias: string, query: string, nodes: number) =>
    `${alias}: search(type: ISSUE, first: ${Math.max(1, nodes)}, query: ${JSON.stringify(
      `${base} ${query}`.trim(),
    )}) { issueCount${nodes > 0 ? ` nodes { ... on PullRequest { ${PULL_FIELDS} } }` : ""} }`;
  const parts = [search("total", "sort:updated-desc", SAMPLE_HEAD)];
  for (let y = firstYear; y <= currentYear; y++) {
    parts.push(
      search(
        `y${y}`,
        `updated:${y}-01-01..${y}-12-31 sort:updated-desc`,
        SAMPLE_PER_YEAR,
      ),
    );
  }
  for (const months of windowMonths(currentYear - firstYear + 1)) {
    parts.push(search(`m${months}`, `updated:>=${windowStart(months)}`, 0));
  }
  return `query { ${parts.join(" ")} }`;
}

type SearchAnswer = { issueCount?: number; nodes?: Json[] };

async function withGraphql(
  client: GitHubClient,
  repo: string,
  createdAt: string,
): Promise<ProbePulls> {
  const currentYear = new Date().getFullYear();
  const created = new Date(createdAt).getFullYear();
  const firstYear = Number.isFinite(created)
    ? Math.min(created, currentYear)
    : currentYear;
  const data = await graphql<Record<string, SearchAnswer>>(
    client,
    countsQuery(repo, firstYear, currentYear),
  );
  const byYear = new Map<number, number>();
  const sample = new Map<number, Json>();
  for (const node of data.total?.nodes ?? []) {
    if (node?.number) sample.set(Number(node.number), restShape(node));
  }
  for (let y = firstYear; y <= currentYear; y++) {
    const answer = data[`y${y}`];
    byYear.set(y, Number(answer?.issueCount ?? 0));
    for (const node of answer?.nodes ?? []) {
      if (node?.number) sample.set(Number(node.number), restShape(node));
    }
  }
  const windows: Record<number, number> = {};
  for (const months of windowMonths(currentYear - firstYear + 1)) {
    windows[months] = Number(data[`m${months}`]?.issueCount ?? 0);
  }
  return {
    counts: { total: Number(data.total?.issueCount ?? 0), byYear },
    windows,
    details: [...sample.values()],
  };
}

async function withRest(
  client: GitHubClient,
  repo: string,
  say: (message: string) => void,
): Promise<ProbePulls> {
  const pulls = await client.pages<Json>(
    `repos/${repo}/pulls?state=all&sort=updated&direction=desc`,
    undefined,
    (page, fetched) =>
      say(`pull request listing · page ${page} · fetched ${fetched}`),
  );
  const counts = pullCountsFromList(pulls);
  const years = counts.byYear.size
    ? new Date().getFullYear() - Math.min(...counts.byYear.keys()) + 1
    : 1;
  const windows: Record<number, number> = {};
  for (const months of windowMonths(years)) {
    windows[months] = pulls.filter((pull) =>
      withinPrWindow(String(pull.updated_at ?? ""), months),
    ).length;
  }
  const yearBuckets = new Map<number, Json[]>();
  for (const pull of pulls) {
    const pullYear = new Date(String(pull.updated_at)).getFullYear();
    yearBuckets.set(pullYear, [...(yearBuckets.get(pullYear) ?? []), pull]);
  }
  const targets = new Map<number, Json>();
  for (const pull of pulls.slice(0, SAMPLE_HEAD)) {
    targets.set(Number(pull.number), pull);
  }
  for (const yearPulls of yearBuckets.values()) {
    for (const pull of yearPulls.slice(0, SAMPLE_PER_YEAR)) {
      targets.set(Number(pull.number), pull);
    }
  }
  return {
    counts,
    windows,
    targets: [...targets.values()],
    updatedAt: pulls.map((pull) => String(pull.updated_at ?? "")),
  };
}

/** The pull request counts and sample, from GraphQL or else REST. */
export function readProbePulls(
  client: GitHubClient,
  repo: string,
  meta: Json,
  say: (message: string) => void,
): Promise<ProbePulls> {
  return graphqlOr(
    client,
    "counting pull requests",
    () => {
      say("counting pull requests");
      return withGraphql(client, repo, String(meta.created_at ?? ""));
    },
    () => {
      say("reading pull request list");
      return withRest(client, repo, say);
    },
  );
}
