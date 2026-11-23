import { afterEach, beforeEach, test } from "node:test";
import { githubFetch, setTransientDelaysForTest } from "./client.ts";
import { GhClient, setGhRunner } from "./gh.ts";
import { collectSource } from "./collect.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import { testOptions } from "../testing/helpers.ts";
import { isolateTestFile } from "../testing/locations.ts";
import type { GitHubClient } from "../types.ts";
import type { CommandOutput } from "../util/runtime.ts";

isolateTestFile();

beforeEach(() => setTransientDelaysForTest([0, 0]));
afterEach(() => {
  setTransientDelaysForTest();
  setGhRunner(undefined);
});

async function withFetch<T>(
  answers: (Response | Error)[],
  run: (calls: () => number) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    const answer = answers[Math.min(calls++, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return answer.clone();
  };
  try {
    return await run(() => calls);
  } finally {
    globalThis.fetch = original;
  }
}

const ok = () => new Response("{}", { status: 200 });
const failed = (status: number) => new Response("{}", { status });

test("a read that gets a 5xx is retried and then succeeds", async () => {
  await withFetch([failed(500), failed(503), ok()], async (calls) => {
    const response = await githubFetch("https://api.github.com/x", {});
    if (response.status !== 200) throw new Error(`got ${response.status}`);
    if (calls() !== 3) throw new Error(`expected 3 calls, got ${calls()}`);
  });
});

test("a read whose connection drops is retried", async () => {
  await withFetch([new TypeError("fetch failed"), ok()], async (calls) => {
    const response = await githubFetch("https://api.github.com/x", {});
    if (response.status !== 200) throw new Error(`got ${response.status}`);
    if (calls() !== 2) throw new Error(`expected 2 calls, got ${calls()}`);
  });
});

test("a read that keeps failing returns the last answer after its retries", async () => {
  await withFetch([failed(502)], async (calls) => {
    const response = await githubFetch("https://api.github.com/x", {});
    if (response.status !== 502) throw new Error(`got ${response.status}`);
    if (calls() !== 3) throw new Error(`expected 3 calls, got ${calls()}`);
  });
});

test("a write is sent once even when it gets a 5xx", async () => {
  await withFetch([failed(500), ok()], async (calls) => {
    const response = await githubFetch("https://api.github.com/x", {
      method: "POST",
    });
    if (response.status !== 500) throw new Error(`got ${response.status}`);
    if (calls() !== 1) throw new Error(`expected 1 call, got ${calls()}`);
  });
});

test("a GraphQL query is a read and is retried", async () => {
  await withFetch([failed(502), ok()], async (calls) => {
    const response = await githubFetch("https://api.github.com/graphql", {
      method: "POST",
    });
    if (response.status !== 200) throw new Error(`got ${response.status}`);
    if (calls() !== 2) throw new Error(`expected 2 calls, got ${calls()}`);
  });
});

function output(success: boolean, text: string): CommandOutput {
  const bytes = new TextEncoder().encode(text);
  return {
    success,
    code: success ? 0 : 1,
    stdout: success ? bytes : new Uint8Array(),
    stderr: success ? new Uint8Array() : bytes,
  };
}

/** Answers `gh api` with `answers` in order and `rate_limit` with a full
 * quota, and counts the calls that are not `rate_limit`. */
function ghAnswers(answers: CommandOutput[]): () => number {
  let calls = 0;
  setGhRunner(async (args) => {
    if (args.includes("rate_limit")) {
      return output(
        true,
        JSON.stringify({
          resources: { core: { remaining: 5000, reset: 0, limit: 5000 } },
        }),
      );
    }
    return answers[Math.min(calls++, answers.length - 1)]!;
  });
  return () => calls;
}

test("gh retries a read that failed with a temporary server error", async () => {
  const calls = ghAnswers([
    output(
      false,
      "gh: Server Error: Sorry, this diff is temporarily unavailable due to heavy server load. (HTTP 500)",
    ),
    // gh separates these parts with a semicolon.
    output(
      false,
      ["stream error: stream ID 1", " CANCEL", " received from peer"].join(
        String.fromCharCode(59),
      ),
    ),
    output(true, '{"ok":true}'),
  ]);
  const body = await new GhClient().request<{ ok: boolean }>("repos/a/b");
  if (!body.ok) throw new Error("no answer");
  if (calls() !== 3) throw new Error(`expected 3 calls, got ${calls()}`);
});

test("gh does not retry a 404", async () => {
  const calls = ghAnswers([output(false, "gh: Not Found (HTTP 404)")]);
  const failed = await new GhClient()
    .request("repos/a/b/contents/x")
    .then(() => false)
    .catch(() => true);
  if (!failed) throw new Error("a 404 did not fail");
  if (calls() !== 1) throw new Error(`expected 1 call, got ${calls()}`);
});

test("gh sends a write once even after a server error", async () => {
  const calls = ghAnswers([
    output(false, "gh: Server Error (HTTP 500)"),
    output(true, "{}"),
  ]);
  const failed = await new GhClient()
    .write("repos/a/b/issues/1/comments", { body: "x" })
    .then(() => false)
    .catch(() => true);
  if (!failed) throw new Error("the write was retried to success");
  if (calls() !== 1) throw new Error(`expected 1 call, got ${calls()}`);
});

const pull = {
  number: 1,
  title: "Change",
  updated_at: "1",
  head: { sha: "head-1" },
  additions: 1,
  deletions: 1,
  labels: [],
};

/** A pull request whose diff GitHub cannot serve. */
class BrokenDiffClient implements GitHubClient {
  async request<T>(endpoint: string): Promise<T> {
    if (endpoint === "repos/fixture/repo") {
      return { default_branch: "main" } as T;
    }
    if (endpoint.includes("/pulls?")) {
      return (/[?&]page=1\b/.test(endpoint) ? [pull] : []) as T;
    }
    throw new Error(`unexpected request endpoint: ${endpoint}`);
  }

  async pages<T>(endpoint: string): Promise<T[]> {
    if (endpoint.includes("/files")) {
      throw new Error("gh could not read the diff (HTTP 500)");
    }
    if (endpoint.includes("/comments") || endpoint.includes("/reviews")) {
      return [];
    }
    throw new Error(`unexpected pages endpoint: ${endpoint}`);
  }
}

test("a pull request whose diff fails is kept without its diff", async () => {
  await cacheDeletePrefix("pr-listing", "fixture/repo");
  await cacheDeletePrefix("pr", "fixture/repo");
  const source = await collectSource(
    new BrokenDiffClient(),
    testOptions({
      includeCodebase: false,
      includePullRequests: true,
      includePullRequestChanges: true,
    }),
  );
  const [kept] = source.pullRequests;
  if (kept?.number !== 1) throw new Error("the pull request was dropped");
  if (kept.diff !== "") throw new Error("a diff came from nowhere");
});
