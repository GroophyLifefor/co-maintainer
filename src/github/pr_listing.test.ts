import { test } from "node:test";
import {
  countPullRequests,
  countQueries,
  DISCUSSION,
  graphqlStates,
  listedShape,
} from "./pr_listing.ts";
import { collectSource } from "./collect.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import { testOptions } from "../testing/helpers.ts";
import { isolateTestFile } from "../testing/locations.ts";
import { withLogSink } from "../util/log.ts";
import type { GitHubClient, Json } from "../types.ts";

isolateTestFile();

test("each wanted state is its own search, and closed means unmerged", () => {
  const queries = countQueries("o/r", ["merged", "closed"]);
  if (
    JSON.stringify(queries) !==
    JSON.stringify([
      "repo:o/r is:pr is:merged",
      "repo:o/r is:pr is:closed is:unmerged",
    ])
  ) {
    throw new Error(JSON.stringify(queries));
  }
  if (countQueries("o/r", undefined)[0] !== "repo:o/r is:pr") {
    throw new Error("every state is one search");
  }
  if (!countQueries("o/r", undefined, 3)[0]!.includes(" updated:>=")) {
    throw new Error("the window is not in the search");
  }
});

test("the state counts add up", async () => {
  const client: GitHubClient = {
    request: async () => ({}) as never,
    pages: async () => [],
    write: async <T>(): Promise<T> =>
      ({ data: { c0: { issueCount: 4 }, c1: { issueCount: 6 } } }) as T,
  };
  const total = await countPullRequests(client, {
    repo: "o/r",
    prState: ["open", "merged"],
  });
  if (total !== 10) throw new Error(`got ${total}`);
});

/** One listed pull request, and a GraphQL count of 14,333. */
class CountedClient implements GitHubClient {
  async request<T>(endpoint: string): Promise<T> {
    if (endpoint === "repos/fixture/repo") {
      return { default_branch: "main" } as T;
    }
    if (endpoint.includes("/pulls?")) {
      return (
        /[?&]page=1\b/.test(endpoint)
          ? [
              {
                number: 1,
                title: "Change",
                updated_at: "1",
                head: { sha: "h" },
                additions: 1,
                deletions: 1,
                labels: [],
              },
            ]
          : []
      ) as T;
    }
    throw new Error(`unexpected request endpoint: ${endpoint}`);
  }

  async pages<T>(): Promise<T[]> {
    return [];
  }

  async write<T>(endpoint: string, body: unknown): Promise<T> {
    const query = String((body as Json).query ?? "");
    if (endpoint === "graphql" && query.includes("issueCount")) {
      return { data: { c0: { issueCount: 14333 } } } as T;
    }
    return { errors: [{ message: "no listing here" }] } as T;
  }
}

test("init's listing progress shows the counted total", async () => {
  await cacheDeletePrefix("pr-listing", "fixture/repo");
  await cacheDeletePrefix("pr", "fixture/repo");
  const lines: string[] = [];
  await withLogSink(
    (_phase, message) => lines.push(message),
    () =>
      collectSource(
        new CountedClient(),
        testOptions({ includeCodebase: false, includePullRequests: true }),
      ),
  );
  if (!lines.some((line) => line.includes("fetched 1 / 14,333"))) {
    throw new Error(lines.join("\n"));
  }
});

function graphqlPull(number: number, extra: Json = {}): Json {
  return {
    number,
    title: `PR ${number}`,
    body: "body",
    state: "MERGED",
    mergedAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    headRefOid: `sha-${number}`,
    additions: 3,
    deletions: 1,
    labels: { nodes: [{ name: "bug" }] },
    comments: { totalCount: 1, nodes: [{ body: "c", url: "u1" }] },
    reviews: {
      totalCount: 1,
      nodes: [{ body: "r", state: "CHANGES_REQUESTED", url: "u2" }],
    },
    reviewThreads: {
      totalCount: 1,
      nodes: [
        {
          comments: {
            totalCount: 1,
            nodes: [{ body: "inline", path: "a.ts", line: 3, url: "u3" }],
          },
        },
      ],
    },
    ...extra,
  };
}

test("a GraphQL pull request reads as a REST listing item with its discussion", () => {
  const item = listedShape(graphqlPull(5));
  const discussion = item[DISCUSSION] as Json;
  if (item.state !== "closed" || !item.merged_at) throw new Error("state");
  if ((item.head as Json).sha !== "sha-5") throw new Error("head");
  if (
    JSON.stringify(discussion.reviewComments) !==
    JSON.stringify([
      {
        body: "inline",
        path: "a.ts",
        line: 3,
        original_line: null,
        html_url: "u3",
      },
    ])
  ) {
    throw new Error(JSON.stringify(discussion.reviewComments));
  }
});

test("a part with more than the query fetched is left for REST", () => {
  const item = listedShape(
    graphqlPull(5, { comments: { totalCount: 101, nodes: [{ body: "c" }] } }),
  );
  const discussion = item[DISCUSSION] as Json;
  if (discussion.comments !== undefined) throw new Error("kept a cut list");
  if (!Array.isArray(discussion.reviews)) throw new Error("lost reviews");
});

test("the states map to GraphQL, every state when none is given", () => {
  if (graphqlStates(undefined).length !== 3) throw new Error("all");
  if (JSON.stringify(graphqlStates(["merged"])) !== '["MERGED"]') {
    throw new Error("merged");
  }
});

/** Two GraphQL listing pages, and REST that counts its calls. */
class ListingClient implements GitHubClient {
  restCalls: string[] = [];
  graphqlPages = 0;
  failOnPage?: number;

  async request<T>(endpoint: string): Promise<T> {
    if (endpoint === "repos/fixture/repo") {
      return { default_branch: "main" } as T;
    }
    this.restCalls.push(endpoint);
    if (endpoint.includes("/pulls?")) {
      return (
        /[?&]page=1\b/.test(endpoint)
          ? [
              {
                number: 9,
                title: "REST",
                updated_at: "1",
                head: { sha: "h" },
                additions: 1,
                deletions: 1,
                labels: [],
              },
            ]
          : []
      ) as T;
    }
    throw new Error(`unexpected request endpoint: ${endpoint}`);
  }

  async pages<T>(endpoint: string): Promise<T[]> {
    this.restCalls.push(endpoint);
    return [];
  }

  async write<T>(_endpoint: string, body: unknown): Promise<T> {
    const query = String((body as Json).query ?? "");
    if (query.includes("issueCount")) {
      return { data: { c0: { issueCount: 2 } } } as T;
    }
    this.graphqlPages++;
    if (this.failOnPage === this.graphqlPages) {
      return { errors: [{ message: "server busy" }] } as T;
    }
    const after = (body as { variables: { after: string | null } }).variables
      .after;
    const page =
      after === null
        ? {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [graphqlPull(2)],
          }
        : {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [graphqlPull(1)],
          };
    return { data: { repository: { pullRequests: page } } } as T;
  }
}

const listingOptions = () =>
  testOptions({
    includeCodebase: false,
    includePullRequests: true,
  });

test("a GraphQL listing reads every page and needs no per pull request call", async () => {
  await cacheDeletePrefix("pr-listing", "fixture/repo");
  await cacheDeletePrefix("pr", "fixture/repo");
  const client = new ListingClient();
  const source = await collectSource(client, listingOptions());
  const numbers = source.pullRequests.map((pr) => pr.number).sort();
  if (JSON.stringify(numbers) !== "[1,2]")
    throw new Error(JSON.stringify(numbers));
  if (client.restCalls.length) throw new Error(client.restCalls.join(", "));
  const [pr] = source.pullRequests;
  if (
    pr!.reviewComments[0] !== "a.ts:3 inline" ||
    pr!.changesRequested !== true
  ) {
    throw new Error(JSON.stringify(pr));
  }
});

test("a GraphQL listing that fails part way is listed again with REST", async () => {
  await cacheDeletePrefix("pr-listing", "fixture/repo");
  await cacheDeletePrefix("pr", "fixture/repo");
  const client = new ListingClient();
  client.failOnPage = 2;
  const source = await collectSource(client, listingOptions());
  const numbers = source.pullRequests.map((pr) => pr.number);
  if (JSON.stringify(numbers) !== "[9]")
    throw new Error(JSON.stringify(numbers));
});

test("labels past the query's limit are kept, not dropped", () => {
  const item = listedShape(
    graphqlPull(5, {
      labels: { totalCount: 60, nodes: [{ name: "a" }, { name: "b" }] },
    }),
  );
  if ((item.labels as Json[]).length !== 2) throw new Error("labels dropped");
});
