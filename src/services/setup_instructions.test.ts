/** `init` and `sync` with and without an `AGENTS.md` on the default branch.
 * GitHub and the AI are both answered through a fake `fetch`. Every test runs
 * in its own sandbox: config, app.db, the guide directory and cache.db all live
 * in a temp directory, never in the real home. */
import { test } from "node:test";
import { readConfig, writeUserConfig } from "../config.ts";
import { closeAppDb } from "../store/app_db.ts";
import { runInitOrRemake } from "./setup.ts";
import { testOptions } from "../testing/helpers.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { withLogSink } from "../util/log.ts";
import { readTextFile, stat } from "../util/runtime.ts";
import { parseRules } from "../knowledge/rules.ts";
import type { Options } from "../types.ts";

const AGENTS = [
  "# Agent notes",
  "Run `npm install` first.",
  "Every exported function in `src/app.ts` has a test.",
].join("\n");

/** What the fake GitHub serves. Tests change it between runs. */
type World = {
  /** `AGENTS.md` content, or `null` when the file is not on the branch. */
  agents: string | null;
  agentsSha: string;
  /** Answer the pull request listing with a server error, which stops the
   * run after the codebase checkpoint. */
  failPulls?: boolean;
  /** Answer every contents request for `AGENTS.md` with a server error. */
  failAgents?: boolean;
};

function chat(prompt: string): string {
  if (prompt.includes("Read the instruction files below")) {
    // Cite whichever line holds the rule, so a test can tell old and new
    // content apart by the source line in RULES.json.
    const files = prompt.slice(prompt.indexOf("FILES:"));
    const match = /^(\d+): (Every exported function.*)$/m.exec(files);
    return JSON.stringify({
      rules: [
        ...(match
          ? [
              {
                rule: match[2],
                scope: "",
                sources: [`AGENTS.md:${match[1]}`],
              },
            ]
          : []),
        {
          rule: "Run npm install first.",
          scope: "",
          sources: ["AGENTS.md:99"],
        },
      ],
    });
  }
  if (prompt.includes("JSON array")) return "[]";
  return "## Section\n\n- Follow the repository convention.\n";
}

function fakeFetch(repo: string, world: World): typeof fetch {
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
          ...(world.agents === null
            ? []
            : [{ path: "AGENTS.md", type: "blob", sha: world.agentsSha }]),
          { path: "src/app.ts", type: "blob", sha: "sha-app" },
        ],
      };
    } else if (url.includes("/contents/AGENTS.md")) {
      if (world.failAgents || world.agents === null) {
        return new Response("{}", { status: 500 });
      }
      body = { content: btoa(world.agents) };
    } else if (url.includes("/contents/")) {
      body = { content: btoa("export function app() {}\n") };
    } else if (url.includes("/pulls")) {
      if (world.failPulls) return new Response("{}", { status: 500 });
      body = [];
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

type Sandbox = {
  repo: string;
  dir: string;
  world: World;
  run(
    overrides?: Partial<Options>,
  ): Promise<{ lines: string[]; stdout: string; error?: unknown }>;
};

async function withSandbox(fn: (sandbox: Sandbox) => Promise<void>) {
  const root = tempDirSync();
  const repo = `acme/agents-${crypto.randomUUID()}`;
  const names = [
    "CM_CONFIG_PATH",
    "CM_APP_DB",
    "CM_REPOS_DIR",
    "XDG_CACHE_HOME",
  ] as const;
  const saved = Object.fromEntries(names.map((name) => [name, getEnv(name)]));
  setEnv("CM_CONFIG_PATH", `${root}/config.json`);
  setEnv("CM_APP_DB", `${root}/app.db`);
  setEnv("CM_REPOS_DIR", `${root}/repos`);
  setEnv("XDG_CACHE_HOME", `${root}/cache`);
  await closeAppDb();
  const world: World = { agents: AGENTS, agentsSha: "sha-agents-1" };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(repo, world);
  const base = testOptions({
    repo,
    auth: "pat",
    githubPat: "test-token",
    ai: "openrouter",
    aiToken: "fake-key",
    lowModel: "low/model",
    highModel: "high/model",
    includeCodebase: true,
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
    await fn({
      repo,
      dir: `${root}/repos/${repo}`,
      world,
      async run(overrides = {}) {
        const lines: string[] = [];
        const printed: string[] = [];
        const log = console.log;
        console.log = (...parts: unknown[]) =>
          void printed.push(parts.join(" "));
        let error: unknown;
        try {
          await withLogSink(
            (phase, message) => void lines.push(`[${phase}] ${message}`),
            () => runInitOrRemake({ ...base, ...overrides }),
          );
        } catch (thrown) {
          error = thrown;
        } finally {
          console.log = log;
        }
        return { lines, stdout: printed.join("\n"), error };
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
    await closeAppDb();
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("init writes INSTRUCTIONS.md and RULES.json and saves the flags, a same-input sync changes nothing", async () => {
  await withSandbox(async ({ repo, dir, run }) => {
    const flags = {
      agentInstructions: "(^|/)AGENTS\\.md$",
      agentInstructionsMaxChars: 8000,
    };
    const first = await run({ ...flags, command: "init" });
    if (first.error) throw first.error;
    if (
      !first.lines.includes(
        "[write] INSTRUCTIONS.md · 1 rule · 1 dropped (unsupported source) · 0 over the cap",
      )
    ) {
      throw new Error(`init output:\n${first.lines.join("\n")}`);
    }
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

    const second = await run({ ...flags, command: "remake" });
    if (second.error) throw second.error;
    if (!second.lines.includes("[instructions] no rule changed")) {
      throw new Error(`sync output:\n${second.lines.join("\n")}`);
    }
    if (
      !second.lines.some((line) =>
        line.includes("cache hit synth_instructions"),
      )
    ) {
      throw new Error(
        "the unchanged instruction files were sent to the AI again",
      );
    }
  });
});

test("a sync of a repository with no instruction file prints, writes and asks nothing new", async () => {
  await withSandbox(async ({ dir, world, run }) => {
    world.agents = null;
    const init = await run({ command: "init" });
    if (init.error) throw init.error;
    const sync = await run({ command: "remake", json: true });
    if (sync.error) throw sync.error;
    const mentions = sync.lines.filter((line) =>
      /instruction|INSTRUCTIONS|RULES\.json/i.test(line),
    );
    if (mentions.length > 0) {
      throw new Error(`new output on a plain sync:\n${mentions.join("\n")}`);
    }
    if (
      (await exists(`${dir}/RULES.json`)) ||
      (await exists(`${dir}/INSTRUCTIONS.md`))
    ) {
      throw new Error("a new file was written");
    }
    const json = JSON.parse(sync.stdout) as Record<string, unknown>;
    if ("instructions" in json || "ruleChanges" in json) {
      throw new Error(`sync --json gained fields: ${sync.stdout}`);
    }
  });
});

test("a sync that fails after the codebase checkpoint does not leave old instruction text behind", async () => {
  await withSandbox(async ({ dir, world, run }) => {
    const runOptions = { includePullRequests: true };
    // Run 1 reads A: the rule is on line 3.
    const first = await run({ ...runOptions, command: "init" });
    if (first.error) throw first.error;
    // Upstream moves the rule to line 4 (content B, a new blob).
    world.agents = `# Agent notes\n\nRun \`npm install\` first.\nEvery exported function in \`src/app.ts\` has a test.\n`;
    world.agentsSha = "sha-agents-2";
    // Run 2 stops after the codebase checkpoint was saved.
    world.failPulls = true;
    const second = await run({ ...runOptions, command: "remake" });
    if (!second.error) throw new Error("run 2 was meant to fail");
    // Run 3 must read B.
    world.failPulls = false;
    const third = await run({ ...runOptions, command: "remake" });
    if (third.error) throw third.error;
    const rules = parseRules(await readTextFile(`${dir}/RULES.json`));
    const sources = JSON.stringify(rules?.rules.I1?.sources);
    if (sources !== '[{"path":"AGENTS.md","line":4}]') {
      throw new Error(`run 3 used old instruction text: ${sources}`);
    }
  });
});

test("when a matched file cannot be fetched, the last INSTRUCTIONS.md and its ids stay", async () => {
  await withSandbox(async ({ dir, world, run }) => {
    const first = await run({ command: "init" });
    if (first.error) throw first.error;
    const before = await readTextFile(`${dir}/INSTRUCTIONS.md`);
    // A new blob, so there is no cached copy, and GitHub fails to serve it.
    world.agentsSha = "sha-agents-2";
    world.failAgents = true;
    const second = await run({ command: "remake" });
    if (second.error) throw second.error;
    if (
      !second.lines.includes(
        "[write] INSTRUCTIONS.md not regenerated: no matched instruction file could be read, keeping any existing file",
      )
    ) {
      throw new Error(`no keep line:\n${second.lines.join("\n")}`);
    }
    if ((await readTextFile(`${dir}/INSTRUCTIONS.md`)) !== before) {
      throw new Error("INSTRUCTIONS.md changed after a failed fetch");
    }
    const rules = parseRules(await readTextFile(`${dir}/RULES.json`));
    if (!rules?.rules.I1) throw new Error("the ids were dropped");
  });
});
