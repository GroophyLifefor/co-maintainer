import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo, markKnowledgeBuilt } from "../store/repos.ts";
import { getDrift, upsertDrift } from "../store/drift.ts";
import { computeDrift, refreshDrift } from "./drift.ts";
import type { GitHubClient } from "../types.ts";

async function withTempDb(fn: () => Promise<void> | void): Promise<void> {
  const original = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_APP_DB", `${Deno.makeTempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", original);
  }
}

const BUILT_AT = "2026-01-01T00:00:00.000Z";
const BASE_SHA = "a".repeat(40);

class FakeClient implements GitHubClient {
  seen: string[] = [];

  async request<T>(endpoint: string): Promise<T> {
    this.seen.push(endpoint);
    if (endpoint.startsWith("repos/acme/widgets/compare/")) {
      return { total_commits: 12, files: [{}, {}, {}] } as T;
    }
    if (endpoint.startsWith("repos/acme/widgets")) {
      return { default_branch: "trunk" } as T;
    }
    if (endpoint.includes("created%3A%3E")) return { total_count: 4 } as T;
    if (endpoint.includes("updated%3A%3E")) return { total_count: 7 } as T;
    throw new Error(`unexpected endpoint ${endpoint}`);
  }

  async pages<T>(endpoint: string): Promise<T[]> {
    this.seen.push(endpoint);
    return [{ sha: "one" }, { sha: "two" }] as T[];
  }
}

Deno.test("computeDrift separates new pull requests from changed ones", async () => {
  const client = new FakeClient();
  const row = await computeDrift(client, "acme/widgets", BUILT_AT, BASE_SHA);
  if (row.prs_since !== 4 || row.prs_updated !== 7) {
    throw new Error(`pull request counts: ${JSON.stringify(row)}`);
  }
  if (row.commits_since !== 12 || row.files_changed !== 3) {
    throw new Error(`code counts: ${JSON.stringify(row)}`);
  }
  const compare = client.seen.find((url) => url.includes("/compare/"));
  if (compare !== `repos/acme/widgets/compare/${BASE_SHA}...trunk`) {
    throw new Error(`compare used the wrong range: ${compare}`);
  }
});

Deno.test("computeDrift falls back to a commit listing without a base sha", async () => {
  const client = new FakeClient();
  const row = await computeDrift(client, "acme/widgets", BUILT_AT, "not-a-sha");
  if (row.commits_since !== 2 || row.files_changed !== 0) {
    throw new Error(`fallback counts: ${JSON.stringify(row)}`);
  }
  if (client.seen.some((url) => url.includes("/compare/"))) {
    throw new Error("compare was called without a real base sha");
  }
});

Deno.test("refreshDrift stores a first reading and then serves it from the table", async () => {
  await withTempDb(async () => {
    activateRepo("acme/widgets", 9);
    markKnowledgeBuilt("acme/widgets", BASE_SHA);
    const client = new FakeClient();

    const first = await refreshDrift("acme/widgets", client);
    if (first?.prs_since !== 4 || first.prs_updated !== 7) {
      throw new Error(`not computed: ${JSON.stringify(first)}`);
    }
    if (getDrift("acme/widgets")?.prs_updated !== 7) {
      throw new Error("the reading was not persisted");
    }

    const calls = client.seen.length;
    await refreshDrift("acme/widgets", client);
    if (client.seen.length !== calls) {
      throw new Error("a fresh row still went to GitHub");
    }
  });
});

Deno.test("refreshDrift keeps the stored row when GitHub fails", async () => {
  await withTempDb(async () => {
    activateRepo("acme/widgets", 9);
    markKnowledgeBuilt("acme/widgets", BASE_SHA);
    upsertDrift({
      repo: "acme/widgets",
      as_of: "2020-01-01T00:00:00.000Z",
      prs_since: 1,
      prs_updated: 2,
      commits_since: 3,
      files_changed: 4,
    });
    const broken: GitHubClient = {
      request: () => Promise.reject(new Error("rate limited")),
      pages: <T>() => Promise.resolve([] as T[]),
    };

    const row = await refreshDrift("acme/widgets", broken);
    if (row?.prs_since !== 1 || row.prs_updated !== 2) {
      throw new Error(`stale row was not kept: ${JSON.stringify(row)}`);
    }
  });
});

Deno.test("refreshDrift does nothing before knowledge is built", async () => {
  await withTempDb(async () => {
    activateRepo("acme/widgets", 9);
    const client = new FakeClient();

    if (await refreshDrift("acme/widgets", client) !== undefined) {
      throw new Error("reported drift against a guide that does not exist");
    }
    if (client.seen.length !== 0) {
      throw new Error("called GitHub with no knowledge to compare against");
    }
  });
});
