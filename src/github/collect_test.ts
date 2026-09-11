import { collectSource } from "./collect.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import { testOptions } from "../testing/helpers.ts";
import type { GitHubClient, Json } from "../types.ts";

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

Deno.test("unchanged codebase blobs are reused on remake", async () => {
  const client = new CacheClient();
  const first = await collectSource(
    client,
    testOptions({ repo: "fixture/repo" }),
  );
  const firstRequests = client.contentRequests;
  const second = await collectSource(
    client,
    testOptions({ repo: "fixture/repo" }),
    { source: first } as never,
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
      return [{
        number: 1,
        title: "Change",
        updated_at: this.updatedAt,
        head: { sha: this.headSha },
        additions: 1,
        deletions: 1,
        labels: [],
      }] as T;
    }
    throw new Error(`unexpected request endpoint: ${endpoint}`);
  }

  async pages<T>(endpoint: string): Promise<T[]> {
    if (endpoint.includes("/pulls?")) {
      return [{
        number: 1,
        title: "Change",
        updated_at: this.updatedAt,
        head: { sha: this.headSha },
        additions: 1,
        deletions: 1,
        labels: [],
      }] as T[];
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

Deno.test("PR discussion and diff caches follow their independent revisions", async () => {
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
  const discussionChanged = await collectSource(
    client,
    prOptions,
    { source: first } as never,
  );
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
  await collectSource(
    client,
    prOptions,
    { source: discussionChanged } as never,
  );
  if (Number(client.fileRequests) !== 2) {
    throw new Error("changed head did not refresh diff");
  }
});

Deno.test("init fetch overlaps PR downloads when concurrent > 1", async () => {
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

Deno.test("PR listing catch-up skips extra GitHub pages", async () => {
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
          return [{
            number: 101,
            title: "PR",
            updated_at: now,
            head: { sha: "h101" },
            additions: 1,
            deletions: 0,
            labels: [],
          }] as T;
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
