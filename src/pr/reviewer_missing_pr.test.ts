/** A pull request that does not exist: every read of it fails, in any order,
 * and the review reports the failure of the pull request read itself. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError } from "../cli/error.ts";
import { isolateTestFile } from "../testing/locations.ts";
import type { GitHubClient, Options } from "../types.ts";
import { reviewPullRequest } from "./reviewer.ts";

isolateTestFile();

const later = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

test("the pull request's own error is reported, even when the comments read fails first", async () => {
  const client = {
    // What gh.ts answers for `pulls/N` in a repository it can read: it asks
    // for the repository first, so this one fails last.
    request: async () => {
      await later(20);
      throw new CliError(
        "pull_request_not_found",
        "Pull request #404 was not found in acme/widgets.",
      );
    },
    // `issues/N/comments` and `pulls/N/reviews` fail at once.
    pages: async () => {
      throw new CliError("repo_not_found", "acme/widgets was not found.");
    },
  } as unknown as GitHubClient;
  await assert.rejects(
    reviewPullRequest(client, {
      repo: "acme/widgets",
      prNumber: 404,
    } as Options),
    { code: "pull_request_not_found" },
  );
});
