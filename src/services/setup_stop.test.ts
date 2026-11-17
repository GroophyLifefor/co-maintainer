/** Stop on a running `init`: the AI call that is running finishes, then no new
 * phase starts and nothing is written. GitHub and the AI answer through a
 * stubbed `fetch`, as in `setup_codebase_flow.test.ts`. */
import { test } from "node:test";
import { runInitOrRemake, StoppedError } from "./setup.ts";
import { closeAppDb } from "../store/app_db.ts";
import { testOptions } from "../testing/helpers.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDir,
} from "../testing/runtime.ts";
import { stat } from "../util/runtime.ts";

const REPO = "acme/stop-flow";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  "src/app.ts": "export const app = 1;\n",
};

function stubFetch(stop: AbortController, calls: { ai: number }): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes("chat/completions")) {
      calls.ai++;
      // Stop is pressed while this call runs. It still answers.
      stop.abort();
      return json({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "[]" },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      });
    }
    if (/\/git\/trees\//.test(url)) {
      return json({
        tree: Object.keys(FILES).map((path) => ({
          path,
          type: "blob",
          sha: path,
        })),
      });
    }
    const contents = /\/contents\/([^?]+)/.exec(url);
    if (contents) {
      const content = FILES[decodeURIComponent(contents[1]!)];
      if (content === undefined) return json({ message: "Not Found" }, 404);
      return json({ content: Buffer.from(content).toString("base64") });
    }
    return json({ default_branch: "main", full_name: REPO });
  }) as unknown as typeof fetch;
}

test("Stop during init lets the running AI call finish, then writes nothing", async () => {
  const root = await tempDir({ prefix: "cm-stop-flow-" });
  const names = [
    "CM_CONFIG_PATH",
    "CM_APP_DB",
    "CM_REPOS_DIR",
    "XDG_CACHE_HOME",
    "LOCALAPPDATA",
    "HOME",
  ] as const;
  const original = names.map((name) => getEnv(name));
  const previousFetch = globalThis.fetch;
  try {
    setEnv("CM_CONFIG_PATH", `${root}/config.json`);
    setEnv("CM_APP_DB", `${root}/app.db`);
    setEnv("CM_REPOS_DIR", `${root}/repos`);
    setEnv("XDG_CACHE_HOME", `${root}/cache`);
    setEnv("LOCALAPPDATA", `${root}/cache`);
    setEnv("HOME", root);
    await closeAppDb();
    const stop = new AbortController();
    const calls = { ai: 0 };
    globalThis.fetch = stubFetch(stop, calls);
    let thrown: unknown;
    try {
      await runInitOrRemake(
        testOptions({
          command: "init",
          repo: REPO,
          auth: "pat",
          githubPat: "test-token",
          ai: "openrouter",
          aiToken: "fake-key",
          lowModel: "low/model",
          highModel: "high/model",
          includeCodebase: true,
          aiConcurrent: 1,
        }),
        stop.signal,
      );
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof StoppedError)) {
      throw new Error(`init did not stop: ${String(thrown)}`);
    }
    if (calls.ai === 0) throw new Error("no AI call ran before the Stop");
    for (const name of ["SKILL.md", "CODEBASE.md", "PR_REVIEW_GUIDE.md"]) {
      const written = await stat(`${root}/repos/${REPO}/${name}`).then(
        () => true,
        () => false,
      );
      if (written) throw new Error(`${name} was written after Stop`);
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
