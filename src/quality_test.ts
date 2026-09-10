import { extractFacts } from "./analysis/facts.ts";
import { buildReviewDocuments } from "./analysis/review.ts";
import { validateSkill } from "./analysis/validate.ts";
import { collectSource } from "./data/data.ts";
import { synthesizeSections } from "./ai/jobs.ts";
import { cacheDeletePrefix } from "./state/database.ts";
import { qualityFixtures } from "./fixtures/quality.ts";
import type {
  AiProvider,
  AiRequest,
  AiResponse,
  Fact,
  GitHubClient,
  Options,
  Source,
} from "./types.ts";

function options(overrides: Partial<Options> = {}): Options {
  return {
    command: "init",
    repo: "fixture/repo",
    debug: false,
    logTime: false,
    improveMatrix: 1,
    concurrent: 1,
    extractConcurrent: 3,
    auth: "gh",
    ai: "none",
    synthesisVersion: 1,
    includeCodebase: true,
    includePullRequests: false,
    includePullRequestChanges: false,
    includeCommitHistory: false,
    includeHowRepoWorks: false,
    ...overrides,
  };
}

function source(overrides: Partial<Source> = {}): Source {
  return {
    repo: { full_name: "fixture/repo", default_branch: "main" },
    tree: ["src/app.ts", "package.json", "pnpm-lock.yaml", "tests/app.test.ts"],
    treeSha: {
      "src/app.ts": "sha-app",
      "package.json": "sha-package",
      "pnpm-lock.yaml": "sha-lock",
      "tests/app.test.ts": "sha-test",
    },
    files: {
      "src/app.ts": "export function app() { return true; }",
      "package.json": '{"scripts":{"test":"deno test","check":"deno check"}}',
    },
    pullRequests: [],
    commits: [],
    ...overrides,
  };
}

Deno.test("facts remain useful for a non-Rust, non-npm fixture", () => {
  const facts = extractFacts(qualityFixtures.node, options());
  if (!facts.some((item) => item.sectionKey === "layout")) {
    throw new Error("expected a module layout fact");
  }
  if (!facts.some((item) => item.claim.includes("pnpm test"))) {
    throw new Error("expected the configured package-manager command");
  }
  if (facts.some((item) => /Rust|cargo/i.test(item.claim))) {
    throw new Error("fixture received language-specific Rust guidance");
  }
  if (facts.some((item) => !item.scope || !item.confidence || !item.status)) {
    throw new Error("fact provenance metadata is missing");
  }
});

Deno.test("quality fixtures cover different repository shapes", () => {
  const cargoFacts = extractFacts(qualityFixtures.cargo, options());
  if (!cargoFacts.some((item) => /cargo test/i.test(item.claim))) {
    throw new Error("Cargo fixture did not produce test guidance");
  }
  const docsFacts = extractFacts(qualityFixtures.docs, options());
  if (!docsFacts.some((item) => item.sectionKey === "devloop")) {
    throw new Error(
      "documentation fixture did not produce development guidance",
    );
  }
});

Deno.test("skill validation rejects raw dumps and unsupported references", async () => {
  const markdown = `---
name: fixture
description: fixture
---

# fixture

## Tests

- Run \`pnpm test\`.
- Use the labels \`x:size/tiny\`, \`x:size/small\`, and \`x:type/ci\`.
- Inspect \`missing/file.ts\`.

| raw | table |
| --- | --- |
| value | value |
`;
  const result = await validateSkill(markdown, ".", source());
  if (result.valid) throw new Error("invalid skill passed validation");
  if (!result.errors.some((error) => error.includes("raw Markdown table"))) {
    throw new Error("raw table was not rejected");
  }
  if (!result.errors.some((error) => error.includes("absent from source"))) {
    throw new Error("unsupported path was not rejected");
  }
});

Deno.test("review guides are optional and avoid duplicate detailed content", () => {
  const facts = [
    fact(
      "Include tests for behavior changes.",
      "current",
      "review discussion (4 mentions)",
    ),
    fact("Keep the pull request focused.", "historical-example", "PR #2"),
    fact("Document public behavior changes.", "historical-example", "PR #3"),
  ].map((item) => ({ ...item, sectionKey: "review-bar" }));
  const documents = buildReviewDocuments(facts);
  if (!documents?.guide.includes("PR review guide")) {
    throw new Error("review guide was not created for repeated requests");
  }
  if (documents.detailed) {
    throw new Error("small review guide unexpectedly created detailed output");
  }
  if (buildReviewDocuments(facts.slice(0, 2))) {
    throw new Error("review guide was created below the request threshold");
  }
  const manyFacts = Array.from(
    { length: 60 },
    (_, index) =>
      fact(
        `Request ${index}: verify the affected behavior.`,
        "historical-example",
        `PR #${index + 1}`,
      ),
  ).map((item) => ({ ...item, sectionKey: "review-bar" }));
  const largeDocuments = buildReviewDocuments(manyFacts);
  if (!largeDocuments?.detailed) {
    throw new Error("detailed review guide was not created for large output");
  }
  if (largeDocuments.detailed.split("\n").length > 500) {
    throw new Error("detailed review guide exceeded 500 lines");
  }
  if (!largeDocuments.guide.includes("PR_REVIEW_DETAILED_GUIDE.md")) {
    throw new Error("short review guide did not reference detailed output");
  }
});

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
    options({ repo: "fixture/repo" }),
  );
  const firstRequests = client.contentRequests;
  const second = await collectSource(
    client,
    options({ repo: "fixture/repo" }),
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
  const prOptions = options({
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
    options({
      includeCodebase: false,
      includePullRequests: true,
      includePullRequestChanges: true,
      concurrent: 2,
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
      options({
        repo,
        includeCodebase: false,
        includePullRequests: true,
      }),
    );
    const firstPages = fetched.listPages;
    await collectSource(
      client,
      options({
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

class SynthesisProvider implements AiProvider {
  requests: AiRequest[] = [];
  valid: boolean;

  constructor(valid: boolean) {
    this.valid = valid;
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(request);
    return {
      text: this.valid
        ? "## Tests\n\n- Run `pnpm test` after behavior changes."
        : "## Tests\n\n| raw | output |\n| --- | --- |\n| x | y |",
      tokensIn: 1,
      tokensOut: 1,
      model: "fixture",
      provider: "openrouter",
    };
  }
}

function fact(
  claim: string,
  scope: Fact["scope"],
  evidence: string,
): Fact {
  return {
    id: `tests:${claim}`,
    sectionKey: "tests",
    claim,
    evidence: [evidence],
    weight: 1,
    scope,
    confidence: scope === "current" ? "high" : "medium",
    status: "active",
  };
}

Deno.test("current evidence is ordered before historical evidence", async () => {
  const repo = `fixture-conflict-${crypto.randomUUID()}`;
  const provider = new SynthesisProvider(true);
  const facts = [
    fact("Use `npm test` after changes.", "historical-example", "PR #1"),
    fact(
      "Use `pnpm test` after changes.",
      "current",
      ".github/workflows/ci.yml",
    ),
  ];
  try {
    await synthesizeSections(
      provider,
      repo,
      facts,
      undefined,
      "openrouter",
      "fixture",
    );
    const prompt = provider.requests[0].prompt;
    if (prompt.indexOf("pnpm test") > prompt.indexOf("npm test")) {
      throw new Error(
        "historical evidence was ordered before current evidence",
      );
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});

Deno.test("invalid synthesis output is omitted instead of copied", async () => {
  const repo = `fixture-invalid-${crypto.randomUUID()}`;
  const provider = new SynthesisProvider(false);
  try {
    const overrides = await synthesizeSections(
      provider,
      repo,
      [fact("Run tests before review.", "current", "workflow")],
      undefined,
      "openrouter",
      "fixture",
    );
    if (overrides.tests !== "") {
      throw new Error("invalid synthesis output was accepted");
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});
