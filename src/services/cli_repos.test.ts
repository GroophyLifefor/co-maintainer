/** A repository built from the CLI reaches the dashboard two ways: `init`
 * registers it in app.db right away, and `serve` finds any built before this
 * existed (an upgrade from an older version) when it starts. Either way it is
 * added once, marked as added from the CLI, and never switched to automatic
 * review on its own. */
import { writeUserConfig } from "../config.ts";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import {
  activateRepo,
  deactivateRepo,
  getRepo,
  registerCliRepo,
} from "../store/repos.ts";
import { discoverCliRepos } from "./cli_repos.ts";
import { runInitOrRemake } from "./setup.ts";
import { cacheDelete } from "../store/cache_db.ts";
import { testOptions } from "../testing/helpers.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { test } from "node:test";

async function withEnv(
  fn: (root: string) => Promise<void>,
  open = true,
): Promise<void> {
  const keys = ["CM_CONFIG_PATH", "CM_APP_DB", "CM_REPOS_DIR"];
  const original = keys.map((key) => getEnv(key));
  const root = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${root}/config.json`);
  setEnv("CM_APP_DB", `${root}/app.db`);
  setEnv("CM_REPOS_DIR", `${root}/repos`);
  try {
    if (open) await openAppDb();
    await fn(root);
  } finally {
    await closeAppDb();
    keys.forEach((key, i) => {
      const value = original[i];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    });
  }
}

async function guide(root: string, repo: string): Promise<void> {
  await mkdirPath(`${root}/repos/${repo}`, { recursive: true });
  await writeTextFile(`${root}/repos/${repo}/PR_REVIEW_GUIDE.md`, "# guide\n");
}

test("registerCliRepo adds a missing repo once, from the CLI, with auto review off", async () => {
  await withEnv(async () => {
    registerCliRepo("acme/cli");
    registerCliRepo("acme/cli");
    const row = getRepo("acme/cli");
    if (
      !row ||
      row.active !== 1 ||
      row.added_from !== "cli" ||
      row.auto_review !== 0
    ) {
      throw new Error(JSON.stringify(row));
    }
  });
});

test("registerCliRepo leaves a repo the dashboard added alone", async () => {
  await withEnv(async () => {
    activateRepo("acme/dash", 9);
    registerCliRepo("acme/dash");
    const row = getRepo("acme/dash");
    if (
      row?.added_from !== null ||
      row.auto_review !== 1 ||
      row.installation_id !== 9
    ) {
      throw new Error(JSON.stringify(row));
    }
  });
});

test("serve finds built repos on disk once, and skips folders with no guide", async () => {
  await withEnv(async (root) => {
    await guide(root, "acme/built");
    await mkdirPath(`${root}/repos/acme/empty`, { recursive: true });
    await writeTextFile(`${root}/repos/stray.txt`, "not a repo");
    const first = await discoverCliRepos();
    if (first.join(",") !== "acme/built")
      throw new Error(`first: ${first.join(",")}`);
    const row = getRepo("acme/built");
    if (
      row?.added_from !== "cli" ||
      !row.knowledge_built_at ||
      row.auto_review !== 0
    ) {
      throw new Error(JSON.stringify(row));
    }
    const second = await discoverCliRepos();
    if (second.length !== 0)
      throw new Error(`second run added ${second.join(",")}`);
  });
});

test("serve does not bring back a repo that was removed from the dashboard", async () => {
  await withEnv(async (root) => {
    activateRepo("acme/removed", 9);
    deactivateRepo("acme/removed");
    await guide(root, "acme/removed");
    const found = await discoverCliRepos();
    if (found.length !== 0 || getRepo("acme/removed")?.active !== 0) {
      throw new Error("a removed repo came back");
    }
  });
});

test("serve with no repos folder yet finds nothing and does not fail", async () => {
  await withEnv(async () => {
    const found = await discoverCliRepos();
    if (found.length !== 0) throw new Error(found.join(","));
  });
});

test("a real CLI init registers its repo in app.db", async () => {
  const repo = `acme/cli-${crypto.randomUUID().slice(0, 8)}`;
  await withEnv(async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      if (String(input).includes("chat/completions")) {
        const prompt = String(init?.body ?? "");
        const content = prompt.includes("JSON array")
          ? "[]"
          : prompt.includes("Write a Markdown review method")
            ? "# PR review guide\\n\\n## Checks\\n- Read the diff · it can hide a regression · always\\n"
            : "## Section\\n\\n- Follow the repository convention.\\n";
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.parse(`"${content}"`),
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ default_branch: "main", full_name: repo }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      await writeUserConfig({
        auth: "pat",
        githubPat: "test-token",
        ai: "openrouter",
        token: "fake-key",
        lowModel: "low/model",
        highModel: "high/model",
      });
      // Like the CLI: app.db is not open when init starts.
      await runInitOrRemake(
        testOptions({
          command: "init",
          repo,
          auth: "pat",
          githubPat: "test-token",
          ai: "openrouter",
          aiToken: "fake-key",
          lowModel: "low/model",
          highModel: "high/model",
          includeCodebase: false,
          includePullRequests: false,
          includePullRequestChanges: false,
          includeCommitHistory: false,
          includeHowRepoWorks: false,
        }),
      );
      await openAppDb();
      const row = getRepo(repo);
      if (!row || row.added_from !== "cli" || !row.knowledge_built_at) {
        throw new Error(`init left no CLI repo row: ${JSON.stringify(row)}`);
      }
    } finally {
      globalThis.fetch = previousFetch;
      await cacheDelete("state", repo);
    }
  }, false);
});
