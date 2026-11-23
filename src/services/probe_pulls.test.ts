import { test } from "node:test";
import {
  countsQuery,
  readProbePulls,
  restShape,
  windowMonths,
} from "./probe_pulls.ts";
import type { GitHubClient, Json } from "../types.ts";

const year = new Date().getFullYear();

test("the windows are the faster ones and every whole number of years", () => {
  const months = windowMonths(3);
  if (JSON.stringify(months) !== "[3,6,12,24,36]") {
    throw new Error(`got ${JSON.stringify(months)}`);
  }
});

test("the query has the total, one search per year and one per window", () => {
  const query = countsQuery("o/r", year - 2, year);
  for (const alias of ["total:", `y${year - 2}:`, `y${year}:`, "m3:", "m36:"]) {
    if (!query.includes(alias)) throw new Error(`no ${alias}`);
  }
  if (!query.includes(`repo:o/r is:pr updated:${year}-01-01..${year}-12-31`)) {
    throw new Error("the year search is wrong");
  }
});

test("a GraphQL pull request reads as a REST detail", () => {
  const shape = restShape({
    number: 7,
    additions: 3,
    deletions: 2,
    isDraft: true,
    updatedAt: "2026-01-01T00:00:00Z",
    author: { login: "dependabot", __typename: "Bot" },
  });
  const user = shape.user as Json;
  if (shape.draft !== true || user.type !== "Bot" || shape.additions !== 3) {
    throw new Error(JSON.stringify(shape));
  }
});

function node(number: number): Json {
  return {
    number,
    additions: 1,
    deletions: 1,
    isDraft: false,
    updatedAt: `${year}-01-02T00:00:00Z`,
    author: { login: "a", __typename: "User" },
  };
}

test("one GraphQL call gives the counts and the sample with no REST call", async () => {
  let restCalls = 0;
  let graphqlCalls = 0;
  const client: GitHubClient = {
    request: async () => {
      restCalls++;
      return {} as never;
    },
    pages: async () => {
      restCalls++;
      return [];
    },
    write: async <T>(): Promise<T> => {
      graphqlCalls++;
      return {
        data: {
          total: { issueCount: 5, nodes: [node(1), node(2)] },
          [`y${year - 1}`]: { issueCount: 2, nodes: [node(3)] },
          [`y${year}`]: { issueCount: 3, nodes: [node(1)] },
          m3: { issueCount: 1 },
          m12: { issueCount: 3 },
        },
      } as T;
    },
  };
  const pulls = await readProbePulls(
    client,
    "o/r",
    { created_at: `${year - 1}-05-01T00:00:00Z` },
    () => {},
  );
  if (graphqlCalls !== 1 || restCalls !== 0) {
    throw new Error(`graphql ${graphqlCalls}, rest ${restCalls}`);
  }
  if (pulls.counts.total !== 5 || pulls.counts.byYear.get(year) !== 3) {
    throw new Error("counts wrong");
  }
  if (pulls.windows[12] !== 3 || pulls.windows[24] !== 0) {
    throw new Error(`windows ${JSON.stringify(pulls.windows)}`);
  }
  const numbers = (pulls.details ?? []).map((detail) => detail.number);
  if (JSON.stringify(numbers) !== "[1,2,3]") {
    throw new Error(`sample ${JSON.stringify(numbers)}`);
  }
});

test("a GraphQL error falls back to the REST listing", async () => {
  const listed = [
    { number: 1, updated_at: `${year}-01-02T00:00:00Z` },
    { number: 2, updated_at: `${year - 1}-01-02T00:00:00Z` },
  ];
  const client: GitHubClient = {
    request: async () => ({}) as never,
    pages: async <T>(): Promise<T[]> => listed as T[],
    write: async <T>(): Promise<T> =>
      ({ errors: [{ message: "search is down" }] }) as T,
  };
  const pulls = await readProbePulls(client, "o/r", {}, () => {});
  if (pulls.counts.total !== 2) throw new Error("REST total wrong");
  if (pulls.targets?.length !== 2 || pulls.details) {
    throw new Error("the REST sample is not left to read");
  }
  if (pulls.updatedAt?.length !== 2) throw new Error("no listing kept");
});
