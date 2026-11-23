/** Codebase files read in batches with GraphQL, instead of one REST call
 * each. A file GraphQL cannot give in full (binary, cut, or a failed batch)
 * is left out of the answer, and the caller reads it with REST as before. */
import { graphql, graphqlOr } from "./graphql.ts";
import type { GitHubClient, Json } from "../types.ts";

/** Files one query asks for. Their texts come back in one answer, so a
 * batch of large files stays a reasonable size. */
export const FILE_BATCH = 20;

export function filesQuery(branch: string, paths: string[]): string {
  const objects = paths
    .map(
      (path, index) =>
        `f${index}: object(expression: ${JSON.stringify(`${branch}:${path}`)}) { ... on Blob { text isBinary isTruncated } }`,
    )
    .join(" ");
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${objects} } }`;
}

/** The texts GraphQL could give in full, by path. A path GitHub says does
 * not exist maps to `undefined`, as the REST read would answer. */
export async function fileTexts(
  client: GitHubClient,
  repo: string,
  branch: string,
  paths: string[],
): Promise<Map<string, string | undefined>> {
  const texts = new Map<string, string | undefined>();
  const [owner, name] = repo.split("/");
  for (let start = 0; start < paths.length; start += FILE_BATCH) {
    const batch = paths.slice(start, start + FILE_BATCH);
    const read = await graphqlOr<Record<string, Json | null> | undefined>(
      client,
      "reading codebase files",
      async () =>
        (
          await graphql<{ repository?: Record<string, Json | null> | null }>(
            client,
            filesQuery(branch, batch),
            { owner, name },
          )
        ).repository ?? undefined,
      async () => undefined,
    );
    if (!read) continue;
    batch.forEach((path, index) => {
      const blob = read[`f${index}`];
      if (blob === null) {
        texts.set(path, undefined);
        return;
      }
      if (
        blob &&
        typeof blob.text === "string" &&
        blob.isBinary !== true &&
        blob.isTruncated !== true
      ) {
        texts.set(path, blob.text);
      }
    });
  }
  return texts;
}
