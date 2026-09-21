import { collectSource } from "./collect.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import { testOptions } from "../testing/helpers.ts";
import { withLogSink } from "../util/log.ts";
import type { State } from "../knowledge/types.ts";
import type { GitHubClient } from "../types.ts";
import { test } from "node:test";

class CacheClient implements GitHubClient {
  contentRequests = 0;

  async request<T>(endpoint: string): Promise<T> {
    if (endpoint === "repos/fixture/repo") {
      return { default_branch: "main" } as T;
    }
    if (endpoint.startsWith("repos/fixture/repo/git/trees/")) {
      return {
        tree: [
          { type: "blob", path: "src/app.ts", sha: "sha-app" },
          { type: "blob", path: "package.json", sha: "sha-package" },
        ],
      } as T;
    }
    if (endpoint.includes("/contents/")) {
      this.contentRequests++;
      return {
        content: btoa('{"scripts":{"test":"deno test"}}'),
      } as T;
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  }

  async pages<T>(): Promise<T[]> {
    return [];
  }
}

test("unchanged codebase blobs are reused on remake", async () => {
  const client = new CacheClient();
  const first = await collectSource(
    client,
    testOptions({ repo: "fixture/repo" }),
  );
  const firstRequests = client.contentRequests;
  const second = await collectSource(
    client,
    testOptions({ repo: "fixture/repo" }),
    {
      source: first,
    } as never,
  );
  if (firstRequests === 0) throw new Error("fixture did not fetch a file");
  if (client.contentRequests !== firstRequests) {
    throw new Error("unchanged codebase file was fetched again");
  }
  if (second.treeSha["src/app.ts"] !== "sha-app") {
    throw new Error("tree blob SHA was not persisted");
  }
});

class PullRequestCacheClient implements GitHubClient {
  updatedAt = "1";
  headSha = "head-1";
  commentsRequests: number = 0;
  reviewRequests: number = 0;
  fileRequests: number = 0;

  async request<T>(endpoint: string): Promise<T> {
    if (endpoint === "repos/fixture/repo") {
      return { default_branch: "main" } as T;
    }
    if (endpoint.includes("/pulls?") && endpoint.includes("state=all")) {
      const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? 1);
      if (page > 1) return [] as T;
      return [
        {
          number: 1,
          title: "Change",
          updated_at: this.updatedAt,
          head: { sha: this.headSha },
          additions: 1,
          deletions: 1,
          labels: [],
        },
      ] as T;
    }
    throw new Error(`unexpected request endpoint: ${endpoint}`);
  }

  async pages<T>(endpoint: string): Promise<T[]> {
    if (endpoint.includes("/pulls?")) {
      return [
        {
          number: 1,
          title: "Change",
          updated_at: this.updatedAt,
          head: { sha: this.headSha },
          additions: 1,
          deletions: 1,
          labels: [],
        },
      ] as T[];
    }
    if (endpoint.includes("/comments")) {
      this.commentsRequests++;
      return [{ body: "please add a test" }] as T[];
    }
    if (endpoint.includes("/reviews")) {
      this.reviewRequests++;
      return [{ body: "looks good" }] as T[];
    }
    if (endpoint.includes("/files")) {
      this.fileRequests++;
      return [{ filename: "src/app.ts", patch: "@@ -1 +1 @@" }] as T[];
    }
    throw new Error(`unexpected pages endpoint: ${endpoint}`);
  }
}

test("PR discussion and diff caches follow their independent revisions", async () => {
  await cacheDeletePrefix("pr-listing", "fixture/repo");
  const client = new PullRequestCacheClient();
  const prOptions = testOptions({
    includeCodebase: false,
    includePullRequests: true,
    includePullRequestChanges: true,
  });
  const first = await collectSource(client, prOptions);
  if (client.commentsRequests !== 1 || client.reviewRequests !== 1) {
    throw new Error("initial PR discussion was not fetched");
  }
  if (client.fileRequests !== 1) {
    throw new Error("initial PR diff was not fetched");
  }

  await collectSource(client, prOptions, { source: first } as never);
  if (client.commentsRequests !== 1 || client.fileRequests !== 1) {
    throw new Error("unchanged PR data was fetched again");
  }

  client.updatedAt = "2";
  const discussionChanged = await collectSource(client, prOptions, {
    source: first,
  } as never);
  if (
    Number(client.commentsRequests) !== 2 ||
    Number(client.reviewRequests) !== 2
  ) {
    throw new Error("changed discussion was not refreshed");
  }
  if (client.fileRequests !== 1) {
    throw new Error("discussion change unnecessarily refreshed the diff");
  }

  client.headSha = "head-2";
  await collectSource(client, prOptions, {
    source: discussionChanged,
  } as never);
  if (Number(client.fileRequests) !== 2) {
    throw new Error("changed head did not refresh diff");
  }
});

test("init fetch overlaps PR downloads when concurrent > 1", async () => {
  await cacheDeletePrefix("pr-listing", "fixture/repo");
  let inflight = 0;
  let peak = 0;
  const client: GitHubClient = {
    async request<T>(endpoint: string): Promise<T> {
      if (endpoint === "repos/fixture/repo") {
        return { default_branch: "main" } as T;
      }
      if (endpoint.includes("/pulls?") && endpoint.includes("state=all")) {
        const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? 1);
        if (page > 1) return [] as T;
        return [
          {
            number: 1,
            title: "One",
            updated_at: "1",
            head: { sha: "h1" },
            additions: 1,
            deletions: 0,
            labels: [],
          },
          {
            number: 2,
            title: "Two",
            updated_at: "1",
            head: { sha: "h2" },
            additions: 1,
            deletions: 0,
            labels: [],
          },
        ] as T;
      }
      throw new Error(`unexpected request endpoint: ${endpoint}`);
    },
    async pages<T>(endpoint: string): Promise<T[]> {
      if (endpoint.includes("/pulls?")) {
        throw new Error("listing should use request pagination");
      }
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inflight--;
      if (endpoint.includes("/comments")) return [{ body: "c" }] as T[];
      if (endpoint.includes("/reviews")) return [] as T[];
      if (endpoint.includes("/files")) {
        return [{ filename: "src/app.ts", patch: "@@ -1 +1 @@" }] as T[];
      }
      throw new Error(`unexpected pages endpoint: ${endpoint}`);
    },
  };
  await collectSource(
    client,
    testOptions({
      includeCodebase: false,
      includePullRequests: true,
      includePullRequestChanges: true,
      ghConcurrent: 2,
    }),
  );
  if (peak < 2) {
    throw new Error(`expected overlapping PR fetches, peak=${peak}`);
  }
});

test("PR listing catch-up skips extra GitHub pages", async () => {
  const repo = `fixture/listing-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const fetched = { listPages: 0 };
  const pageOne = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    title: "PR",
    updated_at: now,
    head: { sha: `h${index + 1}` },
    additions: 1,
    deletions: 0,
    labels: [],
  }));
  const client: GitHubClient = {
    async request<T>(endpoint: string): Promise<T> {
      if (endpoint === `repos/${repo}`) {
        return { default_branch: "main" } as T;
      }
      if (endpoint.includes("/pulls?") && endpoint.includes("state=all")) {
        fetched.listPages++;
        const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? 1);
        if (page === 1) return pageOne as T;
        if (page === 2) {
          return [
            {
              number: 101,
              title: "PR",
              updated_at: now,
              head: { sha: "h101" },
              additions: 1,
              deletions: 0,
              labels: [],
            },
          ] as T;
        }
        return [] as T;
      }
      throw new Error(`unexpected request endpoint: ${endpoint}`);
    },
    async pages<T>(): Promise<T[]> {
      return [] as T[];
    },
  };
  try {
    await collectSource(
      client,
      testOptions({
        repo,
        includeCodebase: false,
        includePullRequests: true,
      }),
    );
    const firstPages = fetched.listPages;
    await collectSource(
      client,
      testOptions({
        repo,
        includeCodebase: false,
        includePullRequests: true,
      }),
    );
    const secondPages = fetched.listPages;
    if (firstPages !== 2 || secondPages !== firstPages + 1) {
      throw new Error(
        `listing pages: first=${firstPages} second=${secondPages}`,
      );
    }
  } finally {
    await cacheDeletePrefix("pr-listing", repo);
    await cacheDeletePrefix("state", repo);
  }
});

function requestChangedClient(repo: string): {
  client: GitHubClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client: GitHubClient = {
    async request<T>(endpoint: string): Promise<T> {
      if (endpoint === `repos/${repo}`) {
        return { default_branch: "main" } as T;
      }
      if (endpoint.includes("/pulls?") && endpoint.includes("state=all")) {
        const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? 1);
        if (page > 1) return [] as T;
        return [
          {
            number: 1,
            title: "Kept",
            updated_at: "1",
            head: { sha: "h1" },
            additions: 1,
            deletions: 0,
            labels: [],
          },
          {
            number: 2,
            title: "Dropped",
            updated_at: "1",
            head: { sha: "h2" },
            additions: 1,
            deletions: 0,
            labels: [],
          },
        ] as T;
      }
      throw new Error(`unexpected request endpoint: ${endpoint}`);
    },
    async pages<T>(endpoint: string): Promise<T[]> {
      calls.push(endpoint);
      if (endpoint.includes("/reviews")) {
        const state = endpoint.includes("/pulls/1/")
          ? "CHANGES_REQUESTED"
          : "APPROVED";
        return [{ state, body: "note" }] as T[];
      }
      if (endpoint.includes("/comments")) return [{ body: "c" }] as T[];
      if (endpoint.includes("/files")) {
        return [{ filename: "src/app.ts", patch: "@@ -1 +1 @@" }] as T[];
      }
      throw new Error(`unexpected pages endpoint: ${endpoint}`);
    },
  };
  return { client, calls };
}

test("--only-request-changed-pr keeps a changes-requested pull request and drops the rest", async () => {
  const repo = `fixture/only-${crypto.randomUUID()}`;
  const { client, calls } = requestChangedClient(repo);
  const lines: string[] = [];
  try {
    const source = await withLogSink(
      (_phase, message) => lines.push(message),
      () =>
        collectSource(
          client,
          testOptions({
            repo,
            includeCodebase: false,
            includePullRequests: true,
            includePullRequestChanges: true,
            onlyRequestChangedPr: true,
          }),
        ),
    );
    if (
      source.pullRequests.length !== 1 ||
      source.pullRequests[0]?.number !== 1
    ) {
      throw new Error(
        `expected PR #1 only, got ${source.pullRequests.map((pr) => pr.number).join(",")}`,
      );
    }
    if (source.pullRequests[0]?.changesRequested !== true) {
      throw new Error("kept pull request did not record changesRequested");
    }
    if (
      calls.some(
        (endpoint) =>
          endpoint.includes("/issues/2/comments") ||
          endpoint.includes("/pulls/2/files"),
      )
    ) {
      throw new Error(`dropped pull request was fetched: ${calls.join(" ")}`);
    }
    if (!lines.includes("only request-changed pr · kept 1 · dropped 1")) {
      throw new Error(`missing summary: ${lines.join(" | ")}`);
    }
    if (
      !lines.some(
        (line) => line.includes("#2") && line.includes("dropped download"),
      )
    ) {
      throw new Error(`drop did not say download: ${lines.join(" | ")}`);
    }
  } finally {
    await cacheDeletePrefix("pr-listing", repo);
  }
});

test("pull request selection is unchanged when --only-request-changed-pr is off", async () => {
  const repo = `fixture/all-${crypto.randomUUID()}`;
  const { client, calls } = requestChangedClient(repo);
  const lines: string[] = [];
  try {
    const source = await withLogSink(
      (_phase, message) => lines.push(message),
      () =>
        collectSource(
          client,
          testOptions({
            repo,
            includeCodebase: false,
            includePullRequests: true,
            includePullRequestChanges: true,
          }),
        ),
    );
    if (source.pullRequests.length !== 2) {
      throw new Error(
        `expected both pull requests, got ${source.pullRequests.length}`,
      );
    }
    if (!calls.some((endpoint) => endpoint.includes("/pulls/2/files"))) {
      throw new Error("flag-off run skipped the second diff");
    }
    if (lines.some((line) => line.startsWith("only request-changed pr"))) {
      throw new Error("summary was logged while the flag was off");
    }
  } finally {
    await cacheDeletePrefix("pr-listing", repo);
  }
});

test("a dropped pull request is cached and not downloaded again", async () => {
  const repo = `fixture/drop-cache-${crypto.randomUUID()}`;
  const { client, calls } = requestChangedClient(repo);
  const options = testOptions({
    repo,
    includeCodebase: false,
    includePullRequests: true,
    includePullRequestChanges: true,
    onlyRequestChangedPr: true,
  });
  try {
    const lines: string[] = [];
    const first = await withLogSink(
      (_phase, message) => lines.push(message),
      () => collectSource(client, options),
    );
    const dropped = first.pullRequestCache?.find((pr) => pr.number === 2);
    if (!dropped || dropped.changesRequested !== false) {
      throw new Error("dropped pull request was not cached");
    }
    if (first.pullRequests.some((pr) => pr.number === 2)) {
      throw new Error("dropped pull request was selected");
    }
    const downloaded = calls.filter((endpoint) =>
      endpoint.includes("/pulls/2/reviews"),
    ).length;
    if (downloaded !== 1) {
      throw new Error(`expected one review download, got ${downloaded}`);
    }
    lines.length = 0;
    await withLogSink(
      (_phase, message) => lines.push(message),
      () =>
        collectSource(client, options, {
          source: first,
          options,
        } as unknown as State),
    );
    const again = calls.filter((endpoint) =>
      endpoint.includes("/pulls/2/reviews"),
    ).length;
    if (again !== downloaded) {
      throw new Error(
        `dropped pull request was downloaded again: ${calls.join(" ")}`,
      );
    }
    if (
      !lines.some(
        (line) => line.includes("#2") && line.includes("dropped cache"),
      )
    ) {
      throw new Error(`second run did not use the cache: ${lines.join(" | ")}`);
    }
  } finally {
    await cacheDeletePrefix("pr-listing", repo);
  }
});

test("commit history reuses the cached list when the tip is unchanged", async () => {
  const repo = `fixture/commits-${crypto.randomUUID()}`;
  const calls: string[] = [];
  const client: GitHubClient = {
    async request<T>(endpoint: string): Promise<T> {
      calls.push(endpoint);
      if (endpoint === `repos/${repo}`) return { default_branch: "main" } as T;
      if (endpoint.includes("/commits?")) {
        const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? 1);
        if (page > 1) return [] as T;
        return [{ sha: "tip" }, { sha: "older" }] as T;
      }
      throw new Error(`unexpected request endpoint: ${endpoint}`);
    },
    async pages<T>(endpoint: string): Promise<T[]> {
      throw new Error(`unexpected pages endpoint: ${endpoint}`);
    },
  };
  const source = await collectSource(
    client,
    testOptions({
      repo,
      includeCodebase: false,
      includeCommitHistory: true,
      maxCommits: 2,
    }),
    {
      source: { commits: [{ sha: "tip" }, { sha: "older" }] },
      options: { maxCommits: 2 },
    } as unknown as State,
  );
  if (
    source.commits.map((commit) => String(commit.sha)).join() !== "tip,older"
  ) {
    throw new Error(`unexpected commits: ${JSON.stringify(source.commits)}`);
  }
  if (calls.some((endpoint) => /page=2/.test(endpoint))) {
    throw new Error(`fetched past the cached tip: ${calls.join(" ")}`);
  }
});

test("--pr-state filters the listing and does not reuse a different state's cache", async () => {
  const repo = `fixture/state-${crypto.randomUUID()}`;
  const calls: string[] = [];
  const pulls = [
    {
      number: 1,
      state: "open",
      updated_at: "1",
      head: { sha: "h1" },
      additions: 1,
      deletions: 0,
      labels: [],
    },
    {
      number: 2,
      state: "closed",
      merged_at: "2020-01-01T00:00:00Z",
      updated_at: "1",
      head: { sha: "h2" },
      additions: 1,
      deletions: 0,
      labels: [],
    },
    {
      number: 3,
      state: "closed",
      updated_at: "1",
      head: { sha: "h3" },
      additions: 1,
      deletions: 0,
      labels: [],
    },
  ];
  const client: GitHubClient = {
    async request<T>(endpoint: string): Promise<T> {
      if (endpoint === `repos/${repo}`) return { default_branch: "main" } as T;
      if (!endpoint.includes("/pulls?")) {
        throw new Error(`unexpected request endpoint: ${endpoint}`);
      }
      calls.push(endpoint);
      const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? 1);
      if (page > 1) return [] as T;
      const query = new URLSearchParams(endpoint.split("?")[1]).get("state");
      const items =
        query === "open"
          ? pulls.filter((pr) => pr.state === "open")
          : query === "closed"
            ? pulls.filter((pr) => pr.state === "closed")
            : pulls;
      return items as T;
    },
    async pages<T>(endpoint: string): Promise<T[]> {
      calls.push(endpoint);
      if (endpoint.includes("/reviews")) return [] as T[];
      if (endpoint.includes("/comments")) return [] as T[];
      if (endpoint.includes("/files")) return [] as T[];
      throw new Error(`unexpected pages endpoint: ${endpoint}`);
    },
  };
  const base = {
    repo,
    includeCodebase: false,
    includePullRequests: true,
    includePullRequestChanges: false,
  };
  try {
    const merged = await collectSource(
      client,
      testOptions({ ...base, prState: ["merged"] }),
    );
    if (merged.pullRequests.map((pr) => pr.number).join(",") !== "2") {
      throw new Error(
        `expected merged #2, got ${merged.pullRequests.map((pr) => pr.number).join(",")}`,
      );
    }
    if (calls.some((endpoint) => /\/pulls\/[13]\//.test(endpoint))) {
      throw new Error(
        `non-merged pull request was fetched: ${calls.join(" ")}`,
      );
    }
    const lines: string[] = [];
    const opened = await withLogSink(
      (_phase, message) => lines.push(message),
      () => collectSource(client, testOptions({ ...base, prState: ["open"] })),
    );
    if (opened.pullRequests.map((pr) => pr.number).join(",") !== "1") {
      throw new Error(
        `expected open #1, got ${opened.pullRequests.map((pr) => pr.number).join(",")}`,
      );
    }
    if (lines.some((line) => line.includes("reused"))) {
      throw new Error(
        `open listing reused the merged cache: ${lines.join(" | ")}`,
      );
    }
  } finally {
    await cacheDeletePrefix("pr-listing", repo);
  }
});
