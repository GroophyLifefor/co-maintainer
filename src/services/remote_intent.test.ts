/** An intent on the server side. It arrives as a client's `revision.description`,
 * which is untrusted text: capped here as well, put in the prompt as context
 * with the sentences that say it is never an instruction, and never echoed. */
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { reposDir, writeUserConfig } from "../config.ts";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo, markKnowledgeBuilt } from "../store/repos.ts";
import { getRemoteReviewInput } from "../store/remote_review_inputs.ts";
import { createRemoteToken } from "./remote_tokens.ts";
import { claimAndRun, getLogsSince } from "./jobs.ts";
import { registerRemoteReviewHandler } from "./remote_review.ts";
import { queuePush, registerPushReviewHandlers } from "./push_review.ts";
import { getRemoteSyncResult } from "../remote/server/sessions.ts";
import { clearByokKeysForTest } from "../remote/server/byok_keys.ts";
import { validateSubmitRequest } from "../remote/validate.ts";
import { REMOTE_MAX_SYSTEM_PROMPT_CHARS } from "../remote/schema.ts";
import { INTENT_PROMPT_NOTE } from "../review/intent.ts";
import { createApp } from "../server/app.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  readTextFile,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";

const REPO = "Owner/Repo";
const INTENT = "Fix rounding for JPY totals, amounts have no decimals.";

type Fake = { url: string; bodies: string[]; close: () => Promise<void> };

/** A fake provider that keeps the body of every call. */
function startFake(): Promise<Fake> {
  const bodies: string[] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += String(chunk);
    });
    request.on("end", () => {
      if (raw) bodies.push(raw);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "fake-1",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({ findings: [] }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 },
        }),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fake provider did not get a port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/api/v1/chat/completions`,
        bodies,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

type Ctx = {
  app: ReturnType<typeof createApp>;
  token: string;
  fake: Fake;
};

async function withServer(
  fn: (ctx: Ctx) => Promise<void>,
  config: Record<string, unknown> = {},
): Promise<void> {
  const root = tempDirSync();
  const fake = await startFake();
  const names = [
    "CM_APP_DB",
    "CM_CONFIG_PATH",
    "CM_REPOS_DIR",
    "CM_OPENROUTER_URL",
    "LOCALAPPDATA",
    "XDG_CACHE_HOME",
    "CM_FAKE_AI",
    "CM_REMOTE_BYOK_POLICY",
  ];
  const saved = new Map(names.map((name) => [name, getEnv(name)]));
  setEnv("CM_APP_DB", `${root}/app.db`);
  setEnv("CM_CONFIG_PATH", `${root}/config.json`);
  setEnv("CM_REPOS_DIR", `${root}/repos`);
  setEnv("CM_OPENROUTER_URL", fake.url);
  setEnv("LOCALAPPDATA", `${root}/cache`);
  setEnv("XDG_CACHE_HOME", `${root}/cache`);
  deleteEnv("CM_FAKE_AI");
  deleteEnv("CM_REMOTE_BYOK_POLICY");
  await openAppDb();
  registerRemoteReviewHandler();
  registerPushReviewHandlers();
  await writeUserConfig({
    ai: "openrouter",
    token: "server-key",
    lowModel: "fake/model",
    highModel: "fake/model",
    auth: "gh",
    ...config,
  });
  activateRepo(REPO, undefined);
  markKnowledgeBuilt(REPO, "abc");
  await mkdirPath(`${reposDir()}/${REPO}`, { recursive: true });
  await writeTextFile(`${reposDir()}/${REPO}/PR_REVIEW_GUIDE.md`, "# Guide\n");
  const { token } = await createRemoteToken("cli");
  try {
    await fn({ app: createApp({ password: "pw" }), token, fake });
  } finally {
    clearByokKeysForTest();
    await closeAppDb();
    await fake.close();
    for (const [name, value] of saved) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
  }
}

async function submitBody(
  description: unknown,
  requestId?: string,
): Promise<Record<string, unknown>> {
  const base = JSON.parse(
    await readTextFile(
      new URL("../remote/fixtures/v1/submit.request.json", import.meta.url),
    ),
  ) as { revision: Record<string, unknown> } & Record<string, unknown>;
  return {
    ...base,
    ...(requestId ? { requestId } : {}),
    revision: { ...base.revision, description },
  };
}

function post(ctx: Ctx, path: string, body: unknown): Promise<Response> {
  return ctx.app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ctx.token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

function must(value: boolean, what: string): void {
  if (!value) throw new Error(what);
}

/** The system and user text of a provider body. */
function parts(raw: string): { system: string; user: string } {
  const messages = (
    JSON.parse(raw) as { messages: { role: string; content: string }[] }
  ).messages;
  return {
    system: messages.find((m) => m.role === "system")?.content ?? "",
    user: messages.find((m) => m.role === "user")?.content ?? "",
  };
}

test("the handshake lists intent among its features", async () => {
  await withServer(async (ctx) => {
    const response = await post(ctx, "/api/remote/handshake", {
      schemaVersion: 1,
      clientVersion: "0.7.0",
      repo: REPO,
    });
    const body = (await response.json()) as { features?: string[] };
    must(body.features?.includes("intent") === true, JSON.stringify(body));
    must(body.features?.includes("byok") === true, "byok stays listed");
  });
});

test("a client's description reaches the prompt as an intent, and the system prompt is unchanged", async () => {
  await withServer(async (ctx) => {
    for (const [description, requestId] of [
      ["", "550e8400-e29b-41d4-a716-446655440001"],
      [INTENT, "550e8400-e29b-41d4-a716-446655440002"],
    ] as const) {
      const response = await post(
        ctx,
        "/api/remote/reviews",
        await submitBody(description, requestId),
      );
      must(response.status === 202, `${response.status}`);
      must(await claimAndRun(), "the review never ran");
    }
    const [plain, given] = ctx.fake.bodies.map(parts);
    must(plain!.system === given!.system, "the system prompt changed");
    must(!given!.system.includes(INTENT), "the text is in the system prompt");
    must(
      given!.user.includes(`"intent":${JSON.stringify(INTENT)}`),
      given!.user.slice(0, 500),
    );
    must(given!.user.includes(INTENT_PROMPT_NOTE), "no defensive sentences");
    must(!plain!.user.includes("INTENT"), "a plain review mentions intent");
  });
});

test("the server never echoes the intent: not in the job log, the result, or once the review is done, the stored input", async () => {
  await withServer(async (ctx) => {
    const response = await post(
      ctx,
      "/api/remote/reviews",
      await submitBody(INTENT),
    );
    const { jobId } = (await response.json()) as { jobId: string };
    must(
      (getRemoteReviewInput(jobId)?.revision_json ?? "").includes(INTENT),
      "the input row holds the description while the job waits",
    );
    must(await claimAndRun(), "the review never ran");
    for (const line of getLogsSince(jobId)) {
      must(!line.message.includes(INTENT), `log: ${line.message}`);
    }
    must(
      !JSON.stringify(getRemoteSyncResult(jobId)).includes(INTENT),
      "the result holds the intent",
    );
    must(getRemoteReviewInput(jobId) === undefined, "the input row is kept");
  });
});

test("the server applies the repository's cap again, and a hard limit above it", async () => {
  await withServer(async (ctx) => {
    const over = await post(
      ctx,
      "/api/remote/reviews",
      await submitBody("x".repeat(8001)),
    );
    must(over.status === 400, `status ${over.status}`);
    const body = (await over.json()) as { error: { message: string } };
    must(
      body.error.message ===
        "revision.description: must be at most 8000 characters (got 8001)",
      body.error.message,
    );
    must(!JSON.stringify(body).includes("xxxx"), "the text was echoed");

    // Whitespace around the text is not part of the intent, so it is not
    // counted.
    const padded = await post(
      ctx,
      "/api/remote/reviews",
      await submitBody(
        ` ${"x".repeat(8000)}\n\n`,
        "550e8400-e29b-41d4-a716-446655440003",
      ),
    );
    must(padded.status === 202, `padded ${padded.status}`);
  });

  await withServer(
    async (ctx) => {
      const over = await post(
        ctx,
        "/api/remote/reviews",
        await submitBody("x".repeat(101)),
      );
      must(over.status === 400, `repo cap ${over.status}`);
      const fits = await post(
        ctx,
        "/api/remote/reviews",
        await submitBody(
          "x".repeat(100),
          "550e8400-e29b-41d4-a716-446655440004",
        ),
      );
      must(fits.status === 202, `at the cap ${fits.status}`);
    },
    { repos: { [REPO]: { reviewSystemPromptMaxChars: 100 } } },
  );

  await withServer(
    async (ctx) => {
      const unlimited = await post(
        ctx,
        "/api/remote/reviews",
        await submitBody("x".repeat(50_000)),
      );
      must(unlimited.status === 202, `no cap ${unlimited.status}`);
      const tooMuch = await post(
        ctx,
        "/api/remote/reviews",
        await submitBody(
          "x".repeat(REMOTE_MAX_SYSTEM_PROMPT_CHARS + 1),
          "550e8400-e29b-41d4-a716-446655440005",
        ),
      );
      must(tooMuch.status === 400, `hard limit ${tooMuch.status}`);
      must(
        (await tooMuch.text()).includes("revision.description: too long"),
        "hard limit message",
      );
    },
    { repos: { [REPO]: { reviewSystemPromptMaxChars: 0 } } },
  );
});

test("the validator takes a string description and nothing else", async () => {
  must(validateSubmitRequest(await submitBody("")) === null, "empty");
  must(validateSubmitRequest(await submitBody(INTENT)) === null, "text");
  const base = (await submitBody("")) as { revision: Record<string, unknown> };
  delete base.revision.description;
  must(validateSubmitRequest(base) === null, "an old client sends none");
  must(
    validateSubmitRequest(await submitBody(5)) ===
      "revision.description: must be a string",
    "a number",
  );
});

test("a push review ignores a description a client sent with its diff", async () => {
  await withServer(async (ctx) => {
    const queued = queuePush({
      repo: REPO,
      before: "1".repeat(40),
      after: "2".repeat(40),
      ref: "refs/heads/main",
      source: "ci",
      revision: {
        title: "",
        description: INTENT,
        baseLabel: "main",
        producer: "remote",
        files: [
          {
            path: "src/small.ts",
            previousPath: null,
            status: "added",
            binary: false,
            additions: 1,
            deletions: 0,
            patch: "@@ -0,0 +1 @@\n+export const a = 1;",
          },
        ],
      },
    });
    must(queued.kind === "enqueued", queued.kind);
    must(await claimAndRun(), "the push review never ran");
    must(ctx.fake.bodies.length > 0, "the provider was never called");
    for (const body of ctx.fake.bodies) {
      must(!body.includes(INTENT), "the intent reached a push review prompt");
    }
  });
});
