/** A local review runs on the provider the user saved, not on OpenRouter.
 *
 * Review was pinned to OpenRouter so Hetzner never wrote one. With the pin
 * gone each provider gets a real CLI run against its fake server, and a fake
 * OpenRouter runs next to it the whole time: a request reaching it would mean
 * the key saved for one provider was sent to another.
 */
import { test } from "node:test";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  envToObject,
  makeTempDir,
  mkdir,
  remove,
  writeTextFile,
} from "../util/runtime.ts";
import {
  Command,
  runtimeExecPath,
  runtimeRunArgs,
} from "../testing/runtime.ts";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";
import { startFakeOpenAi } from "../testing/fake_openai.ts";
import { startFakeAnthropic } from "../testing/fake_anthropic.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO = "e2e-providers/repo";

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await new Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

async function makeWorktree(root: string): Promise<string> {
  const repoDir = `${root}/repos/${REPO}`;
  await mkdir(repoDir, { recursive: true });
  await writeTextFile(
    `${repoDir}/PR_REVIEW_GUIDE.md`,
    "# Review guide\n\nBe terse.\n",
  );
  const worktree = `${root}/worktree`;
  await mkdir(worktree, { recursive: true });
  await git(worktree, ["init"]);
  await git(worktree, ["config", "user.email", "t@t"]);
  await git(worktree, ["config", "user.name", "t"]);
  await writeTextFile(`${worktree}/x.ts`, "export const y = 0\n");
  await git(worktree, ["add", "x.ts"]);
  await git(worktree, ["commit", "-m", "init"]);
  await git(worktree, ["branch", "-M", "main"]);
  await git(worktree, [
    "remote",
    "add",
    "origin",
    `https://github.com/${REPO}.git`,
  ]);
  await git(worktree, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await writeTextFile(`${worktree}/x.ts`, "export const y = 1\n");
  await git(worktree, ["commit", "-am", "change"]);
  return worktree;
}

async function runReview(
  root: string,
  ai: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const worktree = await makeWorktree(root);
  const configPath = `${root}/config.json`;
  await writeTextFile(
    configPath,
    `${JSON.stringify({
      auth: "gh",
      ai,
      token: "saved-key",
      lowModel: "fake-model",
      highModel: "fake-model",
    })}\n`,
  );
  const result = await new Command(runtimeExecPath(), {
    args: runtimeRunArgs(join(projectRoot, "main.ts"), [
      "review",
      `--repo=${REPO}`,
      "--disable-codegraph",
      "--json",
    ]),
    cwd: worktree,
    env: {
      ...envToObject(),
      CM_CONFIG_PATH: configPath,
      CM_REPOS_DIR: `${root}/repos`,
      LOCALAPPDATA: `${root}/localappdata`,
      XDG_CACHE_HOME: `${root}/cache`,
      CM_FAKE_AI: undefined,
      CM_FAKE_REVIEW_FILE: undefined,
      OPENROUTER_API_KEY: undefined,
      CO_MAINTAINER_TOKEN: undefined,
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function expectClean(
  label: string,
  run: { code: number; stdout: string; stderr: string },
): void {
  if (run.code !== 0) {
    throw new Error(`${label} exit ${run.code}:\n${run.stdout}\n${run.stderr}`);
  }
  const parsed = JSON.parse(run.stdout) as { ok?: boolean };
  if (parsed.ok !== true) throw new Error(`${label} not ok:\n${run.stdout}`);
}

test("review: a saved OpenAI provider reviews through OpenAI and never calls OpenRouter", async () => {
  const openai = await startFakeOpenAi("structured-output");
  const openrouter = await startFakeOpenRouter("success");
  const root = await makeTempDir({ prefix: "cm-review-openai-" });
  try {
    const run = await runReview(root, "openai", {
      CM_OPENAI_URL: openai.url,
      CM_OPENROUTER_URL: openrouter.url,
    });
    expectClean("openai", run);
    if (openai.requests.length === 0) {
      throw new Error("the review never reached OpenAI");
    }
    if (openrouter.requests.length !== 0) {
      throw new Error("the OpenAI key was sent to OpenRouter");
    }
  } finally {
    await remove(root, { recursive: true });
    await openai.close();
    await openrouter.close();
  }
});

test("review: a saved Anthropic provider reviews through Anthropic and never calls OpenRouter", async () => {
  const anthropic = await startFakeAnthropic("structured-output");
  const openrouter = await startFakeOpenRouter("success");
  const root = await makeTempDir({ prefix: "cm-review-anthropic-" });
  try {
    const run = await runReview(root, "anthropic", {
      CM_ANTHROPIC_URL: anthropic.url,
      CM_OPENROUTER_URL: openrouter.url,
    });
    expectClean("anthropic", run);
    if (anthropic.requests.length === 0) {
      throw new Error("the review never reached Anthropic");
    }
    if (openrouter.requests.length !== 0) {
      throw new Error("the Anthropic key was sent to OpenRouter");
    }
  } finally {
    await remove(root, { recursive: true });
    await anthropic.close();
    await openrouter.close();
  }
});

type Seen = { path: string; headers: IncomingHttpHeaders };

/** Chat Completions under OpenCode's paths, answering every call with an
 * empty findings list and keeping the path and headers of each one. */
async function startFakeOpenCode(): Promise<{
  origin: string;
  seen: Seen[];
  close: () => Promise<void>;
}> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      seen.push({ path: request.url ?? "", headers: request.headers });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: '{"findings":[]}' } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake OpenCode did not get a port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    seen,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

for (const variant of ["opencode-zen", "opencode-go"] as const) {
  test(`review: ${variant} calls Chat Completions under its own path with its session headers`, async () => {
    const opencode = await startFakeOpenCode();
    const openrouter = await startFakeOpenRouter("success");
    const root = await makeTempDir({ prefix: `cm-review-${variant}-` });
    try {
      const run = await runReview(root, variant, {
        CM_OPENCODE_URL: opencode.origin,
        CM_OPENROUTER_URL: openrouter.url,
      });
      expectClean(variant, run);
      const path =
        variant === "opencode-go"
          ? "/zen/go/v1/chat/completions"
          : "/zen/v1/chat/completions";
      if (opencode.seen.length === 0) {
        throw new Error(`the review never reached ${variant}`);
      }
      for (const call of opencode.seen) {
        if (call.path !== path) throw new Error(`path: ${call.path}`);
        if (call.headers.authorization !== "Bearer saved-key") {
          throw new Error(`auth: ${call.headers.authorization}`);
        }
        if (!String(call.headers["user-agent"]).startsWith("co-maintainer/")) {
          throw new Error(`user agent: ${call.headers["user-agent"]}`);
        }
      }
      const sessions = new Set(
        opencode.seen.map((call) => call.headers["x-opencode-session"]),
      );
      if (sessions.size !== 1 || !sessions.values().next().value) {
        throw new Error(`session ids: ${[...sessions].join(", ")}`);
      }
      if (openrouter.requests.length !== 0) {
        throw new Error(`the ${variant} key was sent to OpenRouter`);
      }
      const usage = (
        JSON.parse(run.stdout) as { usage?: { costStatus?: string } }
      ).usage;
      if (usage?.costStatus !== "unknown") {
        throw new Error(`cost should be unknown: ${JSON.stringify(usage)}`);
      }
    } finally {
      await remove(root, { recursive: true });
      await opencode.close();
      await openrouter.close();
    }
  });
}
