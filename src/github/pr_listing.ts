/** init's pull request listing over GraphQL: the count shown in the
 * progress line. */
import { graphql } from "./graphql.ts";
import type { GitHubClient, Options } from "../types.ts";

/** The search qualifier of each `--pr-state`. Search has no OR between
 * states, so each wanted state is its own count and they add up. */
const STATE_QUALIFIER = {
  open: "is:open",
  merged: "is:merged",
  closed: "is:closed is:unmerged",
} as const;

/** The first day of a `--max-pr-months` window, as a search date. */
function windowStart(months: number): string {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff.toISOString().slice(0, 10);
}

/** One search query per wanted state, for the repository and window. */
export function countQueries(
  repo: string,
  states: Options["prState"],
  maxPrMonths?: number,
): string[] {
  const window = maxPrMonths ? ` updated:>=${windowStart(maxPrMonths)}` : "";
  const base = `repo:${repo} is:pr${window}`;
  if (!states || states.length === 0) return [base];
  return [...new Set(states)].map(
    (state) => `${base} ${STATE_QUALIFIER[state]}`,
  );
}

/** How many pull requests the listing will keep, from search counts. Search
 * runs a little behind and a little under REST, so this is for progress, not
 * for stopping. */
export async function countPullRequests(
  client: GitHubClient,
  options: Pick<Options, "repo" | "prState" | "maxPrMonths">,
): Promise<number> {
  const queries = countQueries(
    options.repo,
    options.prState,
    options.maxPrMonths,
  );
  const aliases = queries
    .map(
      (query, index) =>
        `c${index}: search(type: ISSUE, first: 1, query: ${JSON.stringify(query)}) { issueCount }`,
    )
    .join(" ");
  const data = await graphql<Record<string, { issueCount?: number }>>(
    client,
    `query { ${aliases} }`,
  );
  return queries.reduce(
    (sum, _, index) => sum + Number(data[`c${index}`]?.issueCount ?? 0),
    0,
  );
}
