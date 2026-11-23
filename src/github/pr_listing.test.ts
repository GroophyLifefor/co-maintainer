import { test } from "node:test";
import { countPullRequests, countQueries } from "./pr_listing.ts";
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
