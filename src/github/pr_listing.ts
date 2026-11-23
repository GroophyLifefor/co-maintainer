/** init's pull request listing over GraphQL: the count shown in the
 * progress line. */
import { graphql } from "./graphql.ts";
import type { GitHubClient, Json, Options } from "../types.ts";

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

/** Pull requests a listing page asks for. Each brings its comments, reviews
 * and review threads, so the page is kept small. */
export const LISTING_PAGE = 20;
const COMMENTS = 100;
const REVIEWS = 100;
const THREADS = 50;
const THREAD_COMMENTS = 30;

export const LISTING_QUERY = `query($owner: String!, $name: String!, $states: [PullRequestState!], $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: $states, orderBy: { field: UPDATED_AT, direction: DESC }, first: ${LISTING_PAGE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body state mergedAt updatedAt headRefOid additions deletions
        labels(first: 50) { nodes { name } }
        comments(first: ${COMMENTS}) { totalCount nodes { body url createdAt } }
        reviews(first: ${REVIEWS}) { totalCount nodes { body state url } }
        reviewThreads(first: ${THREADS}) { totalCount nodes { comments(first: ${THREAD_COMMENTS}) { totalCount nodes { body path line originalLine url createdAt } } } }
      }
    }
  }
}`;

/** The discussion a listed pull request brought along, in the REST shapes
 * the per pull request reading takes. A part that did not fit the query is
 * left out, and that part is read with REST as before. */
export type ListedDiscussion = {
  comments?: Json[];
  reviewComments?: Json[];
  reviews?: Json[];
};

/** The key a GraphQL-listed pull request carries its discussion under. It is
 * dropped before the listing is cached. */
export const DISCUSSION = "__discussion";

type Connection = { totalCount?: number; nodes?: Json[] };

/** The nodes, or undefined when the connection had more than it sent. */
function complete(connection: unknown): Json[] | undefined {
  const value = (connection ?? {}) as Connection;
  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  return Number(value.totalCount ?? nodes.length) > nodes.length
    ? undefined
    : nodes;
}

function reviewComments(threads: unknown): Json[] | undefined {
  const all = complete(threads);
  if (!all) return undefined;
  const comments: Json[] = [];
  for (const thread of all) {
    const nodes = complete(thread.comments);
    if (!nodes) return undefined;
    comments.push(...nodes);
  }
  return comments
    .sort((a, b) =>
      String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
    )
    .map((comment) => ({
      body: String(comment.body ?? ""),
      path: String(comment.path ?? ""),
      line: comment.line ?? null,
      original_line: comment.originalLine ?? null,
      html_url: String(comment.url ?? ""),
    }));
}

/** A GraphQL pull request in the REST listing shape, with its discussion. */
export function listedShape(node: Json): Json {
  const labels = complete(node.labels) ?? [];
  const comments = complete(node.comments);
  const reviews = complete(node.reviews);
  const discussion: ListedDiscussion = {
    ...(comments
      ? {
          comments: comments.map((comment) => ({
            body: String(comment.body ?? ""),
            html_url: String(comment.url ?? ""),
          })),
        }
      : {}),
    ...(reviews
      ? {
          reviews: reviews.map((review) => ({
            body: String(review.body ?? ""),
            state: String(review.state ?? ""),
            html_url: String(review.url ?? ""),
          })),
        }
      : {}),
  };
  const threads = reviewComments(node.reviewThreads);
  if (threads) discussion.reviewComments = threads;
  return {
    number: Number(node.number),
    title: String(node.title ?? ""),
    body: String(node.body ?? ""),
    state: node.state === "OPEN" ? "open" : "closed",
    merged_at: node.mergedAt ?? null,
    updated_at: String(node.updatedAt ?? ""),
    head: { sha: String(node.headRefOid ?? "") },
    labels: labels.map((label) => ({ name: String(label.name ?? "") })),
    additions: Number(node.additions ?? 0),
    deletions: Number(node.deletions ?? 0),
    [DISCUSSION]: discussion,
  };
}

/** GraphQL's states for `--pr-state`. Every state when none is given. */
export function graphqlStates(states: Options["prState"]): string[] {
  if (!states || states.length === 0) return ["OPEN", "CLOSED", "MERGED"];
  return [...new Set(states)].map((state) => state.toUpperCase());
}

export type ListingPage = { items: Json[]; next?: string };

/** One page of the listing, newest update first. `next` is the cursor of
 * the following page, absent on the last one. */
export async function listingPage(
  client: GitHubClient,
  repo: string,
  states: Options["prState"],
  after?: string,
): Promise<ListingPage> {
  const [owner, name] = repo.split("/");
  const data = await graphql<{
    repository?: {
      pullRequests?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Json[];
      };
    } | null;
  }>(client, LISTING_QUERY, {
    owner,
    name,
    states: graphqlStates(states),
    after: after ?? null,
  });
  const connection = data.repository?.pullRequests;
  if (!connection) throw new Error(`GitHub GraphQL has no ${repo}`);
  const info = connection.pageInfo ?? {};
  return {
    items: (connection.nodes ?? []).map(listedShape),
    ...(info.hasNextPage && info.endCursor ? { next: info.endCursor } : {}),
  };
}
