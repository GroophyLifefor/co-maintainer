/** `init` and `sync` with an `AGENTS.md` on the default branch: the file is
 * read, one `synth_instructions` call answers, `INSTRUCTIONS.md` and
 * `RULES.json` are written, the flags are saved, and a second run with the
 * same input reports no change. GitHub and the AI are both answered through a
 * fake `fetch`. */
import { test } from "node:test";
import { readConfig, writeUserConfig } from "../config.ts";
import { closeAppDb } from "../store/app_db.ts";
import { cacheDelete, cacheDeletePrefix } from "../store/cache_db.ts";
import { runInitOrRemake } from "./setup.ts";
import { testOptions } from "../testing/helpers.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { withLogSink } from "../util/log.ts";
import { readTextFile } from "../util/runtime.ts";
import { parseRules } from "../knowledge/rules.ts";

const AGENTS = [
  "# Agent notes",
  "Run `npm install` first.",
  "Every exported function in `src/app.ts` has a test.",
].join("\n");

function chat(prompt: string): string {
  if (prompt.includes("Read the instruction files below")) {
    return JSON.stringify({
      rules: [
        {
          rule: "Every exported function in `src/app.ts` has a test.",
          scope: "",
          sources: ["AGENTS.md:3"],
        },
        { rule: "Run npm install first.", scope: "", sources: ["AGENTS.md:9"] },
      ],
    });
  }
  if (prompt.includes("JSON array")) return "[]";
  return "## Section\n\n- Follow the repository convention.\n";
}

function fakeFetch(repo: string): typeof fetch {
  return (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    let body: unknown = { default_branch: "main", full_name: repo };
    if (url.includes("chat/completions")) {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: { content?: unknown }[];
      };
      const prompt = (parsed.messages ?? [])
        .map((message) => String(message.content ?? ""))
        .join("\n");
      body = {
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: chat(prompt) },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      };
    } else if (url.includes("/git/trees/")) {
      body = {
        tree: [
          { path: "AGENTS.md", type: "blob", sha: "sha-agents" },
          { path: "src/app.ts", type: "blob", sha: "sha-app" },
        ],
      };
    } else if (url.includes("/contents/AGENTS.md")) {
      body = { content: btoa(AGENTS) };
    } else if (url.includes("/contents/")) {
      body = { content: btoa("export function app() {}\n") };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

test("init writes INSTRUCTIONS.md and RULES.json and saves the flags, a same-input sync changes nothing", async () => {
  const root = tempDirSync();
  const repo = `acme/agents-${crypto.randomUUID()}`;
  const saved = {
    config: getEnv("CM_CONFIG_PATH"),
    db: getEnv("CM_APP_DB"),
    repos: getEnv("CM_REPOS_DIR"),
  };
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) deleteEnv(name);
    else setEnv(name, value);
  };
  setEnv("CM_CONFIG_PATH", `${root}/config.json`);
  setEnv("CM_APP_DB", `${root}/app.db`);
  setEnv("CM_REPOS_DIR", `${root}/repos`);
  await closeAppDb();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(repo);
  const options = testOptions({
    repo,
    auth: "pat",
    githubPat: "test-token",
    ai: "openrouter",
    aiToken: "fake-key",
    lowModel: "low/model",
    highModel: "high/model",
    includeCodebase: true,
    agentInstructions: "(^|/)AGENTS\\.md$",
    agentInstructionsMaxChars: 8000,
  });
  try {
    await writeUserConfig({
      auth: "pat",
      githubPat: "test-token",
      ai: "openrouter",
      token: "fake-key",
      lowModel: "low/model",
      highModel: "high/model",
    });
    const first: string[] = [];
    await withLogSink(
      (phase, message) => void first.push(`[${phase}] ${message}`),
      () => runInitOrRemake({ ...options, command: "init" }),
    );
    if (
      !first.includes(
        "[write] INSTRUCTIONS.md · 1 rule · 1 dropped (unsupported source) · 0 over the cap",
      )
    ) {
      throw new Error(`init output:\n${first.join("\n")}`);
    }
    const dir = `${root}/repos/${repo}`;
    const instructions = await readTextFile(`${dir}/INSTRUCTIONS.md`);
    if (
      !instructions.includes(
        "- Every exported function in `src/app.ts` has a test. [I1]",
      ) ||
      instructions.includes("npm install")
    ) {
      throw new Error(`INSTRUCTIONS.md:\n${instructions}`);
    }
    const rules = parseRules(await readTextFile(`${dir}/RULES.json`));
    if (
      JSON.stringify(rules?.rules.I1?.sources) !==
      '[{"path":"AGENTS.md","line":3}]'
    ) {
      throw new Error(`RULES.json: ${JSON.stringify(rules)}`);
    }
    const repoConfig = readConfig().repos?.[repo];
    if (
      repoConfig?.agentInstructions !== "(^|/)AGENTS\\.md$" ||
      repoConfig?.agentInstructionsMaxChars !== 8000
    ) {
      throw new Error(`saved config: ${JSON.stringify(repoConfig)}`);
    }

    const second: string[] = [];
    await withLogSink(
      (phase, message) => void second.push(`[${phase}] ${message}`),
      () => runInitOrRemake({ ...options, command: "remake" }),
    );
    if (!second.includes("[instructions] no rule changed")) {
      throw new Error(`sync output:\n${second.join("\n")}`);
    }
    if (!second.some((line) => line.includes("cache hit synth_instructions"))) {
      throw new Error(
        "the unchanged instruction files were sent to the AI again",
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
    await cacheDelete("state", repo);
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
    await closeAppDb();
    restore("CM_CONFIG_PATH", saved.config);
    restore("CM_APP_DB", saved.db);
    restore("CM_REPOS_DIR", saved.repos);
  }
});
