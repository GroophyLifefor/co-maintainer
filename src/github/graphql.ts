/** GitHub GraphQL over the client's own `write`, so the `gh`, token and App
 * clients all speak it with their own auth and retries. A client without
 * `write` (most test fakes) has no GraphQL, and every caller falls back to
 * the REST path it used before. */
import type { GitHubClient } from "../types.ts";
import { log } from "../util/log.ts";
import { interrupted } from "../util/interrupt.ts";

/** Raised when GraphQL cannot answer: no `write`, an error list, or no
 * data. The caller logs it and takes the REST path. */
export class GraphqlUnavailable extends Error {}

type GraphqlBody<T> = { data?: T | null; errors?: { message?: string }[] };

export function hasGraphql(client: GitHubClient): boolean {
  return typeof client.write === "function";
}

/** Runs one query. Partial data with errors counts as a failure, since a
 * missing alias would read as a zero count. */
export async function graphql<T>(
  client: GitHubClient,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  if (!client.write) {
    throw new GraphqlUnavailable("this GitHub client has no GraphQL");
  }
  const body = await client.write<GraphqlBody<T>>("graphql", {
    query,
    variables,
  });
  if (body?.errors?.length) {
    throw new GraphqlUnavailable(
      `GitHub GraphQL: ${body.errors.map((error) => error.message ?? "error").join(", ")}`,
    );
  }
  if (!body?.data) throw new GraphqlUnavailable("GitHub GraphQL sent no data");
  return body.data;
}

/** `fn` with GraphQL, or `fallback` when GraphQL fails for any reason. The
 * fallback is today's REST path, so a failure costs time, never the run. */
export async function graphqlOr<T>(
  client: GitHubClient,
  what: string,
  fn: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  if (!hasGraphql(client)) return fallback();
  try {
    return await fn();
  } catch (error) {
    if (interrupted()) throw error;
    log(
      "github",
      `${what} with GraphQL failed, reading it with REST: ${error instanceof Error ? error.message : String(error)}`,
    );
    return fallback();
  }
}
