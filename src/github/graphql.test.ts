import { test } from "node:test";
import { graphql, graphqlOr, GraphqlUnavailable } from "./graphql.ts";
import type { GitHubClient } from "../types.ts";

function client(answer: unknown, sent: unknown[] = []): GitHubClient {
  return {
    request: async () => {
      throw new Error("no REST here");
    },
    pages: async () => [],
    write: async <T>(endpoint: string, body: unknown): Promise<T> => {
      sent.push({ endpoint, body });
      return answer as T;
    },
  };
}

test("a query is sent to the graphql endpoint and its data comes back", async () => {
  const sent: unknown[] = [];
  const data = await graphql<{ n: number }>(
    client({ data: { n: 3 } }, sent),
    "query { n }",
    { a: 1 },
  );
  if (data.n !== 3) throw new Error("data missing");
  const [call] = sent as { endpoint: string; body: { variables: unknown } }[];
  if (call?.endpoint !== "graphql") throw new Error("wrong endpoint");
  if (JSON.stringify(call.body.variables) !== '{"a":1}') {
    throw new Error("variables not sent");
  }
});

test("an error list fails the query even with partial data", async () => {
  const failed = await graphql(
    client({ data: { n: 3 }, errors: [{ message: "bad alias" }] }),
    "query { n }",
  ).catch((error) => error);
  if (!(failed instanceof GraphqlUnavailable)) throw new Error("no failure");
  if (!String(failed.message).includes("bad alias")) {
    throw new Error("the GitHub message was lost");
  }
});

test("a client without write takes the fallback without a call", async () => {
  const bare: GitHubClient = {
    request: async () => ({}) as never,
    pages: async () => [],
  };
  let tried = false;
  const value = await graphqlOr(
    bare,
    "counting",
    async () => {
      tried = true;
      return "graphql";
    },
    async () => "rest",
  );
  if (value !== "rest" || tried) throw new Error("GraphQL was tried");
});

test("a failed GraphQL query takes the fallback", async () => {
  const value = await graphqlOr(
    client({ errors: [{ message: "nope" }] }),
    "counting",
    () => graphql(client({ errors: [{ message: "nope" }] }), "query { n }"),
    async () => "rest",
  );
  if (value !== "rest") throw new Error("no fallback");
});
