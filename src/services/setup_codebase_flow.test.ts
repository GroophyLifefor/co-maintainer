/** CODEBASE.md through real `init` and `sync` runs.
 *
 * `setup_codebase.test.ts` checks the helpers. This runs `runInitOrRemake`
 * itself, with GitHub and the AI answered by a stubbed `fetch`, so the wiring
 * between the hashes, the synthesis and the file is under test too.
 */
import { test } from "node:test";
import { runInitOrRemake } from "./setup.ts";
import { closeAppDb } from "../store/app_db.ts";
import { testOptions } from "../testing/helpers.ts";
import {
  deleteEnv,
  getEnv,
  readTextFile,
  removePath,
  setEnv,
  tempDir,
  writeTextFile,
} from "../testing/runtime.ts";

const REPO = "acme/codebase-flow";

type World = {
  files: Record<string, string>;
  /** The section whose every synthesis call fails. */
  failSection?: string;
  /** The section the model answers with only its heading. */
  emptySection?: string;
  /** Section keys asked for, one per HTTP call. */
  asked: string[];
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function chat(content: string): Response {
  return json({
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content } },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
  });
}

function stubFetch(world: World): typeof fetch {
  return (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (url.includes("chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: { content?: unknown }[];
      };
      const prompt = (body.messages ?? [])
        .map((message) => String(message.content ?? ""))
        .join("\n");
      const key = /Markdown for the "([a-z-]+)" section/.exec(prompt)?.[1];
      if (!key) return chat(prompt.includes("JSON array") ? "[]" : "");
      world.asked.push(key);
      if (key === world.failSection) {
        return json({ error: { message: "upstream failed" } }, 500);
      }
      if (key === world.emptySection) return chat("## Heading only\n");
      return chat(`## Section\n\n- The ${key} rule the model wrote.\n`);
    }
    const tree = /\/git\/trees\//.test(url);
    if (tree) {
      return json({
        tree: Object.entries(world.files).map(([path, content]) => ({
          path,
          type: "blob",
          sha: `${path}:${content.length}`,
        })),
      });
    }
    const contents = /\/contents\/([^?]+)/.exec(url);
    if (contents) {
      const path = decodeURIComponent(contents[1]!);
      const content = world.files[path];
      if (content === undefined) return json({ message: "Not Found" }, 404);
      return json({ content: Buffer.from(content).toString("base64") });
    }
    return json({ default_branch: "main", full_name: REPO });
  }) as unknown as typeof fetch;
}

function run(command: "init" | "remake"): Promise<void> {
  return runInitOrRemake(
    testOptions({
      command,
      repo: REPO,
      auth: "pat",
      githubPat: "test-token",
      ai: "openrouter",
      aiToken: "fake-key",
      lowModel: "low/model",
      highModel: "high/model",
      includeCodebase: true,
    }),
  );
}

function titles(markdown: string): string[] {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
}

test("CODEBASE.md keeps a section whose call failed, rebuilds a lost one and drops an empty one", async () => {
  const root = await tempDir({ prefix: "cm-codebase-flow-" });
  const names = [
    "CM_CONFIG_PATH",
    "CM_APP_DB",
    "CM_REPOS_DIR",
    "XDG_CACHE_HOME",
    "LOCALAPPDATA",
    "HOME",
  ] as const;
  const original = names.map((name) => getEnv(name));
  setEnv("CM_CONFIG_PATH", `${root}/config.json`);
  setEnv("CM_APP_DB", `${root}/app.db`);
  setEnv("CM_REPOS_DIR", `${root}/repos`);
  // State and the AI cache live in cache.db. Keep it in the temp directory.
  setEnv("XDG_CACHE_HOME", `${root}/cache`);
  setEnv("LOCALAPPDATA", `${root}/cache`);
  setEnv("HOME", root);
  await closeAppDb();
  const world: World = {
    files: {
      "package.json": JSON.stringify({
        scripts: { test: "node --test", build: "tsc -p ." },
      }),
      "src/app.ts": "export const app = 1;\n",
      "tests/app.test.ts": "import '../src/app.ts';\n",
    },
    asked: [],
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(world);
  const codebase = () => readTextFile(`${root}/repos/${REPO}/CODEBASE.md`);
  try {
    await run("init");
    const all = ["Code layout", "Tests", "Development and debugging"];
    const afterInit = titles(await codebase());
    if (all.some((title) => !afterInit.includes(title))) {
      throw new Error(`init wrote ${afterInit.join(", ")}`);
    }

    // A new top-level directory changes the layout facts, and every layout
    // call fails.
    world.files["lib/util.ts"] = "export {};\n";
    world.failSection = "layout";
    world.asked = [];
    await run("remake");
    const afterFailure = await codebase();
    if (!world.asked.includes("layout")) {
      throw new Error(`layout was not rebuilt: ${world.asked.join(", ")}`);
    }
    if (!afterFailure.includes("- The layout rule the model wrote.")) {
      throw new Error(`a failed call dropped Code layout:\n${afterFailure}`);
    }

    // A plain sync after it: nothing changed, the section is still there.
    world.failSection = undefined;
    await run("remake");
    if (!titles(await codebase()).includes("Code layout")) {
      throw new Error(
        `Code layout lost on the next sync:\n${await codebase()}`,
      );
    }

    // A file an earlier run cut short, as 0.6.13 did: the next sync rebuilds
    // the missing section though its facts did not change.
    const cut = (await codebase()).replace(/## Tests\n[\s\S]*?(?=\n## |$)/, "");
    await writeTextFile(`${root}/repos/${REPO}/CODEBASE.md`, cut);
    await run("remake");
    if (!titles(await codebase()).includes("Tests")) {
      throw new Error(
        `the lost Tests section stayed lost:\n${await codebase()}`,
      );
    }

    // The test facts change and the model has nothing durable to say: the old
    // Tests text was written from facts that are gone, so it is dropped.
    world.files["package.json"] = JSON.stringify({
      scripts: { test: "node --test --watch", build: "tsc -p ." },
    });
    world.emptySection = "tests";
    await run("remake");
    const afterEmpty = titles(await codebase());
    if (afterEmpty.includes("Tests")) {
      throw new Error(
        `an empty answer kept the old Tests text:\n${await codebase()}`,
      );
    }
    if (!afterEmpty.includes("Code layout")) {
      throw new Error(
        `an unrelated section was lost: ${afterEmpty.join(", ")}`,
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
    await closeAppDb();
    names.forEach((name, index) => {
      const value = original[index];
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    });
    await removePath(root, { recursive: true });
  }
});
