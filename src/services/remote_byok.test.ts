/** CORE-110: Bring Your Own Key on the server side.
 *
 * The client's key is the server's least forgiving input: it must reach the
 * provider and nothing else. These tests drive a real `createApp` remote route
 * and a real review job against a socket-level fake provider, then check the
 * key appears in exactly one place (the provider's Authorization header) and
 * in none of app.db, cache.db, the config, or the job logs. */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  cacheDbPath,
  configPath,
  reposDir,
  writeUserConfig,
} from "../config.ts";
import { appDbPath, closeAppDb, getAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo, markKnowledgeBuilt } from "../store/repos.ts";
import { getRemoteReviewInput } from "../store/remote_review_inputs.ts";
import { getJob } from "../store/jobs.ts";
import { getReviewByJobId, remoteTokenUsageSince } from "../store/reviews.ts";
import { createRemoteToken } from "./remote_tokens.ts";
import { claimAndRun, cancel } from "./jobs.ts";
import { registerRemoteReviewHandler } from "./remote_review.ts";
import {
  byokKeyCountForTest,
  clearByokKeysForTest,
  hasByokKey,
} from "../remote/server/byok_keys.ts";
import { createApp } from "../server/app.ts";
import { redact } from "../util/redact.ts";
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
const SERVER_KEY = "server-key-change-me";
const SINCE = "2000-01-01T00:00:00.000Z";

type KeyFake = {
  url: string;
  authorizations: string[];
  close: () => Promise<void>;
};

/** A socket-level fake provider that records the Authorization header of every
 * call. The OpenRouter provider is what a review uses by default, so the header
 * is `Bearer <key>`; the point is to prove which key reached the socket. */
function startKeyFake(
  options: { status?: number; content?: string; errorMessage?: string } = {},
): Promise<KeyFake> {
  const authorizations: string[] = [];
  const server: Server = createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      authorizations.push(request.headers.authorization ?? "");
      const status = options.status ?? 200;
      const body =
        status === 200
          ? JSON.stringify({
              id: "fake-1",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    role: "assistant",
                    content:
                      options.content ?? JSON.stringify({ findings: [] }),
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 },
            })
          : JSON.stringify({
              error: { message: options.errorMessage ?? "Invalid API key" },
            });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
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
        authorizations,
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
  root: string;
  app: ReturnType<typeof createApp>;
  token: string;
  tokenId: string;
  fake: KeyFake;
};

/** Boots a server-shaped world: temp app.db/cache/config, an initialized repo,
 * a remote token, and a fake provider the review will actually call. */
async function withServer(
  fn: (ctx: Ctx) => Promise<void>,
  options: {
    policy?: "off" | "allow" | "require";
    /** A raw CM_REMOTE_BYOK_POLICY value, including invalid ones, set instead
     * of `policy` so a test can prove how a bad env value is handled. */
    rawPolicyEnv?: string;
    /** The policy written to config.json; pairs with `rawPolicyEnv` to prove
     * the env override falls back to the saved policy. */
    configPolicy?: "off" | "allow" | "require";
    fakeStatus?: number;
    fakeErrorMessage?: string;
  } = {},
): Promise<void> {
  const root = tempDirSync();
  const fake = await startKeyFake({
    status: options.fakeStatus,
    errorMessage: options.fakeErrorMessage,
  });
  const saved = new Map<string, string | undefined>();
  const restore: string[] = [];
  const set = (name: string, value: string): void => {
    if (!saved.has(name)) saved.set(name, getEnv(name));
    setEnv(name, value);
  };
  set("CM_APP_DB", `${root}/app.db`);
  set("CM_CONFIG_PATH", `${root}/config.json`);
  set("CM_REPOS_DIR", `${root}/repos`);
  set("CM_OPENROUTER_URL", fake.url);
  // getCacheDir picks the platform-appropriate one; set both so the byte scan
  // finds cache.db wherever this runs.
  set("LOCALAPPDATA", `${root}/cache`);
  set("XDG_CACHE_HOME", `${root}/cache`);
  if (options.policy) set("CM_REMOTE_BYOK_POLICY", options.policy);
  else if (options.rawPolicyEnv !== undefined)
    set("CM_REMOTE_BYOK_POLICY", options.rawPolicyEnv);
  else {
    saved.set("CM_REMOTE_BYOK_POLICY", getEnv("CM_REMOTE_BYOK_POLICY"));
    deleteEnv("CM_REMOTE_BYOK_POLICY");
  }
  saved.set("CM_FAKE_AI", getEnv("CM_FAKE_AI"));
  deleteEnv("CM_FAKE_AI");
  restore.push(
    "CM_APP_DB",
    "CM_CONFIG_PATH",
    "CM_REPOS_DIR",
    "CM_OPENROUTER_URL",
    "LOCALAPPDATA",
    "XDG_CACHE_HOME",
    "CM_REMOTE_BYOK_POLICY",
    "CM_FAKE_AI",
  );

  await openAppDb();
  registerRemoteReviewHandler();
  await writeUserConfig({
    ai: "openrouter",
    token: SERVER_KEY,
    lowModel: "fake/model",
    highModel: "fake/model",
    auth: "gh",
    ...(options.configPolicy ? { remoteByokPolicy: options.configPolicy } : {}),
  });
  activateRepo(REPO, undefined);
  markKnowledgeBuilt(REPO, "abc");
  await mkdirPath(`${reposDir()}/${REPO}`, { recursive: true });
  await writeTextFile(`${reposDir()}/${REPO}/PR_REVIEW_GUIDE.md`, "# Guide\n");
  await writeTextFile(`${reposDir()}/${REPO}/CODEBASE.md`, "# Codebase\n");
  const { id: tokenId, token } = await createRemoteToken("cli");
  const app = createApp({ password: "pw" });

  try {
    await fn({ root, app, token, tokenId, fake });
  } finally {
    clearByokKeysForTest();
    await closeAppDb();
    await fake.close();
    for (const name of restore) {
      const original = saved.get(name);
      if (original === undefined) deleteEnv(name);
      else setEnv(name, original);
    }
  }
}

async function submitBody(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const base = JSON.parse(
    await readTextFile(
      new URL("../remote/fixtures/v1/submit.request.json", import.meta.url),
    ),
  ) as Record<string, unknown>;
  return { ...base, ...overrides };
}

function post(
  app: ReturnType<typeof createApp>,
  token: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

function handshakeRequest(token: string): Request {
  return new Request("http://localhost/api/remote/handshake", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      schemaVersion: 1,
      clientVersion: "0.5.0",
      repo: REPO,
    }),
  });
}

function readBytes(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

test("CORE-110: handshake advertises byok and the active policy, never a secret", async () => {
  for (const [policy, expected] of [
    [undefined, "off"],
    ["off", "off"],
    ["allow", "allow"],
    ["require", "require"],
  ] as const) {
    await withServer(
      async ({ app, token }) => {
        const response = await app.fetch(handshakeRequest(token));
        if (response.status !== 200) {
          throw new Error(
            `handshake ${response.status}: ${await response.text()}`,
          );
        }
        const body = (await response.json()) as {
          features?: string[];
          byok?: { policy?: string };
          ai?: { provider?: string };
          token?: { name?: string };
        };
        if (!body.features?.includes("byok")) {
          throw new Error(`features: ${JSON.stringify(body.features)}`);
        }
        if (body.byok?.policy !== expected) {
          throw new Error(`policy ${body.byok?.policy}, expected ${expected}`);
        }
        if (body.ai?.provider !== "openrouter") {
          throw new Error(`ai.provider ${body.ai?.provider}`);
        }
        // Nothing in the handshake may echo the server key.
        const raw = JSON.stringify(body);
        if (raw.includes(SERVER_KEY)) {
          throw new Error("the handshake leaked the server key");
        }
      },
      { policy },
    );
  }
});

test("CORE-110: submit matrix across the three policies", async () => {
  const KEY = "sk-ant-bringyourown0001";

  // off: a key is refused, a 0.5.0 client still works.
  await withServer(
    async ({ app, token }) => {
      const withKey = await post(app, token, "/api/remote/reviews", {
        ...(await submitBody()),
        byok: { key: KEY },
      });
      if (withKey.status !== 403) {
        throw new Error(`off+key: ${withKey.status}`);
      }
      const refused = (await withKey.json()) as {
        error?: { code?: string; message?: string };
      };
      if (refused.error?.code !== "byok_not_allowed") {
        throw new Error(`code ${refused.error?.code}`);
      }
      if (
        refused.error?.message !== "This server does not accept your own key."
      ) {
        throw new Error(`message ${refused.error?.message}`);
      }
      const withoutKey = await post(
        app,
        token,
        "/api/remote/reviews",
        await submitBody(),
      );
      if (withoutKey.status !== 202) {
        throw new Error(`off, no key: ${withoutKey.status}`);
      }
    },
    { policy: "off" },
  );

  // allow: both a key and no key are accepted.
  await withServer(
    async ({ app, token }) => {
      const withKey = await post(app, token, "/api/remote/reviews", {
        ...(await submitBody()),
        byok: { key: KEY },
      });
      if (withKey.status !== 202)
        throw new Error(`allow+key: ${withKey.status}`);
      const withoutKey = await post(
        app,
        token,
        "/api/remote/reviews",
        await submitBody(),
      );
      if (withoutKey.status !== 202)
        throw new Error(`allow, no key: ${withoutKey.status}`);
    },
    { policy: "allow" },
  );

  // require: the key is mandatory, and an old client gets a clear refusal.
  await withServer(
    async ({ app, token }) => {
      const withoutKey = await post(
        app,
        token,
        "/api/remote/reviews",
        await submitBody(),
      );
      if (withoutKey.status !== 403) {
        throw new Error(`require, no key: ${withoutKey.status}`);
      }
      const refused = (await withoutKey.json()) as {
        error?: { code?: string; message?: string };
      };
      if (refused.error?.code !== "byok_required") {
        throw new Error(`code ${refused.error?.code}`);
      }
      if (!refused.error?.message?.includes("requires your own key")) {
        throw new Error(`message ${refused.error?.message}`);
      }
      const withKey = await post(app, token, "/api/remote/reviews", {
        ...(await submitBody()),
        byok: { key: KEY },
      });
      if (withKey.status !== 202)
        throw new Error(`require+key: ${withKey.status}`);
    },
    { policy: "require" },
  );
});

test("CORE-110: a BYOK review sends the client key, never the server key", async () => {
  const KEY = "sk-ant-clientpaid0001";
  await withServer(
    async ({ app, token, tokenId, fake }) => {
      const response = await post(app, token, "/api/remote/reviews", {
        ...(await submitBody()),
        byok: { key: KEY },
      });
      if (response.status !== 202) {
        throw new Error(`submit ${response.status}: ${await response.text()}`);
      }
      const { jobId } = (await response.json()) as { jobId: string };

      // Before it runs, the input row says who pays and holds no key.
      const input = getRemoteReviewInput(jobId);
      if (input?.billed_to !== "byok") {
        throw new Error(`input billed_to ${input?.billed_to}`);
      }
      if (JSON.stringify(input).includes(KEY)) {
        throw new Error("the key reached the stored input row");
      }

      if (!(await claimAndRun())) throw new Error("the review job never ran");
      if (getJob(jobId)?.status !== "done") {
        throw new Error(`job ${getJob(jobId)?.status}`);
      }
      if (getReviewByJobId(jobId)?.billed_to !== "byok") {
        throw new Error(
          `review billed_to ${getReviewByJobId(jobId)?.billed_to}`,
        );
      }
      if (fake.authorizations.length === 0) {
        throw new Error("the provider was never called");
      }
      for (const header of fake.authorizations) {
        if (header !== `Bearer ${KEY}`) {
          throw new Error(`provider saw ${header}, expected the client key`);
        }
      }

      // The server's spending totals exclude BYOK; BYOK is its own column.
      const usage = remoteTokenUsageSince(tokenId, SINCE);
      if (usage.knownCount !== 0 || usage.byokKnownCount !== 1) {
        throw new Error(`usage ${JSON.stringify(usage)}`);
      }
    },
    { policy: "allow" },
  );
});

test("CORE-110: a server-key review bills the server and never touches BYOK totals", async () => {
  await withServer(
    async ({ app, token, tokenId, fake }) => {
      const response = await post(
        app,
        token,
        "/api/remote/reviews",
        await submitBody(),
      );
      if (response.status !== 202) throw new Error(`submit ${response.status}`);
      const { jobId } = (await response.json()) as { jobId: string };
      if (getRemoteReviewInput(jobId)?.billed_to !== "server") {
        throw new Error("a client with no key must bill the server");
      }
      await claimAndRun();
      if (getReviewByJobId(jobId)?.billed_to !== "server") {
        throw new Error("review should be billed to the server");
      }
      for (const header of fake.authorizations) {
        if (header !== `Bearer ${SERVER_KEY}`) {
          throw new Error(`provider saw ${header}, expected the server key`);
        }
      }
      const usage = remoteTokenUsageSince(tokenId, SINCE);
      if (usage.knownCount !== 1 || usage.byokKnownCount !== 0) {
        throw new Error(`usage ${JSON.stringify(usage)}`);
      }
    },
    { policy: "allow" },
  );
});

test("CORE-110: a restart loses the key and the job fails without calling the provider", async () => {
  await withServer(
    async ({ app, token, fake }) => {
      const response = await post(app, token, "/api/remote/reviews", {
        ...(await submitBody()),
        byok: { key: "sk-ant-lostacrossrestart" },
      });
      const { jobId } = (await response.json()) as { jobId: string };
      // A restart empties the in-memory map before the queued job runs.
      clearByokKeysForTest();
      await claimAndRun();
      const job = getJob(jobId);
      if (job?.status !== "failed") {
        throw new Error(`job ${job?.status}`);
      }
      if (!job.error?.includes("was not kept across a server restart")) {
        throw new Error(`error ${job.error}`);
      }
      if (fake.authorizations.length !== 0) {
        throw new Error("a lost key must not fall back to any provider key");
      }
      if (getReviewByJobId(jobId)?.status !== "failed") {
        throw new Error("review should be failed");
      }
    },
    { policy: "allow" },
  );
});

test("CORE-110: a provider that rejects the client key reports it as BYOK", async () => {
  await withServer(
    async ({ app, token, fake }) => {
      const response = await post(app, token, "/api/remote/reviews", {
        ...(await submitBody()),
        byok: { key: "sk-ant-rejected0001" },
      });
      const { jobId } = (await response.json()) as { jobId: string };
      await claimAndRun();
      const job = getJob(jobId);
      if (job?.status !== "failed") throw new Error(`job ${job?.status}`);
      if (!job.error?.includes("The AI provider rejected your own key.")) {
        throw new Error(`error ${job.error}`);
      }
      if (fake.authorizations.length === 0) {
        throw new Error("the provider should have been tried once");
      }
    },
    { policy: "allow", fakeStatus: 401 },
  );
});

test("CORE-110: a retried submit with the key gone reports byok_key_lost", async () => {
  await withServer(
    async ({ app, token }) => {
      const body = {
        ...(await submitBody()),
        byok: { key: "sk-ant-retrysameid0001" },
      };
      const first = await post(app, token, "/api/remote/reviews", body);
      const { jobId } = (await first.json()) as { jobId: string };

      // Same request id while the key is still in memory: the original job.
      const retry = await post(app, token, "/api/remote/reviews", body);
      if (retry.status !== 202) throw new Error(`retry ${retry.status}`);
      if (((await retry.json()) as { jobId: string }).jobId !== jobId) {
        throw new Error("a retried submit must return the same job");
      }

      // Key gone (restart), same request id: a typed refusal, not the server key.
      clearByokKeysForTest();
      const afterRestart = await post(app, token, "/api/remote/reviews", body);
      if (afterRestart.status !== 409) {
        throw new Error(`after restart: ${afterRestart.status}`);
      }
      const refused = (await afterRestart.json()) as {
        error?: { code?: string };
      };
      if (refused.error?.code !== "byok_key_lost") {
        throw new Error(`code ${refused.error?.code}`);
      }
    },
    { policy: "allow" },
  );
});

test("CORE-110: a unique client key never lands in app.db, cache.db, config, or logs", async () => {
  const KEY = `sk-ant-leakcanary${Math.random().toString(36).slice(2)}0000`;
  await withServer(
    async ({ app, token, root }) => {
      const response = await post(app, token, "/api/remote/reviews", {
        ...(await submitBody()),
        byok: { key: KEY },
      });
      if (response.status !== 202) throw new Error(`submit ${response.status}`);
      const { jobId } = (await response.json()) as { jobId: string };
      await claimAndRun();

      // The masking function knows this key shape, so a log line that somehow
      // carried it would be redacted rather than leak. Prove both halves.
      if (!redact(`authorization: Bearer ${KEY}`).includes("[redacted]")) {
        throw new Error("an Anthropic-shaped key is not covered by redaction");
      }
      const { getLogsSince } = await import("./jobs.ts");
      for (const line of getLogsSince(jobId)) {
        if (line.message.includes(KEY)) {
          throw new Error(`the key reached the job log: ${line.message}`);
        }
      }

      const appDb = appDbPath();
      const files = [
        appDb,
        `${appDb}-wal`,
        `${appDb}-shm`,
        cacheDbPath(),
        configPath(),
      ];
      for (const path of files) {
        const bytes = readBytes(path);
        if (bytes?.includes(KEY)) {
          throw new Error(`the key landed in ${path}`);
        }
      }
      // Sanity: the scan reads real data, not empty files.
      if (!readBytes(appDb)) throw new Error("app.db was not found to scan");
      if (!root) throw new Error("missing temp root");
    },
    { policy: "allow" },
  );
});

test("CORE-110: a queued BYOK job canceled before it runs drops the key", async () => {
  const KEY = "sk-ant-queuedcancel0001";
  await withServer(
    async ({ app, token }) => {
      const response = await post(app, token, "/api/remote/reviews", {
        ...(await submitBody()),
        byok: { key: KEY },
      });
      if (response.status !== 202) throw new Error(`submit ${response.status}`);
      const { jobId } = (await response.json()) as { jobId: string };
      if (!hasByokKey(jobId)) {
        throw new Error("the key should be held while the job is queued");
      }
      // The dashboard cancels the queued job before the worker ever claims it.
      if (!cancel(jobId, "dashboard_canceled")) {
        throw new Error("cancel() did not find the queued job");
      }
      if (getJob(jobId)?.status !== "canceled") {
        throw new Error(`job ${getJob(jobId)?.status}`);
      }
      // A queued job never enters the handler, so nothing else would drop the
      // key; it must not outlive the cancellation (CORE-110).
      if (hasByokKey(jobId)) {
        throw new Error("a canceled queued job left its key in memory");
      }
    },
    { policy: "allow" },
  );
});

test("CORE-110: a superseded BYOK job drops the key when a newer submit arrives", async () => {
  const KEY = "sk-ant-superseded0001";
  await withServer(
    async ({ app, token }) => {
      const first = await post(app, token, "/api/remote/reviews", {
        ...(await submitBody()),
        byok: { key: KEY },
      });
      const { jobId: firstJobId } = (await first.json()) as { jobId: string };
      if (!hasByokKey(firstJobId)) {
        throw new Error("the first key should be held while its job is queued");
      }
      // A second submit on the same repo/branch/token supersedes the first.
      const secondBody = {
        ...(await submitBody({
          requestId: "550e8400-e29b-41d4-a716-446655440001",
        })),
        byok: { key: "sk-ant-secondsubmit0001" },
      };
      const second = await post(app, token, "/api/remote/reviews", secondBody);
      if (second.status !== 202) throw new Error(`second ${second.status}`);
      if (getJob(firstJobId)?.status !== "canceled") {
        throw new Error(`superseded job ${getJob(firstJobId)?.status}`);
      }
      // The superseded job never reaches its own `finally`, so its key has to
      // be dropped when it is superseded (CORE-110).
      if (hasByokKey(firstJobId)) {
        throw new Error("a superseded job left its key in memory");
      }
    },
    { policy: "allow" },
  );
});

test("CORE-110: an invalid CM_REMOTE_BYOK_POLICY falls back to config, not off", async () => {
  // A configured `require` must survive a typo'd env value: the env override is
  // meant to be authoritative, so an unreadable one has to fall back to the
  // saved policy rather than silently disabling it (review round 1, P2).
  await withServer(
    async ({ app, token }) => {
      const withoutKey = await post(
        app,
        token,
        "/api/remote/reviews",
        await submitBody(),
      );
      if (withoutKey.status !== 403) {
        throw new Error(
          `a require policy was silently disabled by a bad env value: ${withoutKey.status}`,
        );
      }
      const refused = (await withoutKey.json()) as {
        error?: { code?: string };
      };
      if (refused.error?.code !== "byok_required") {
        throw new Error(`code ${refused.error?.code}`);
      }
    },
    { rawPolicyEnv: "requrie", configPolicy: "require" },
  );
});

test("CORE-110: a provider 5xx is not reported as a rejected BYOK key", async () => {
  // Only an authentication rejection proves the client's key is bad. A
  // provider outage must surface as itself, not as "rejected your own key"
  // (review round 1, P2).
  await withServer(
    async ({ app, token }) => {
      const response = await post(app, token, "/api/remote/reviews", {
        ...(await submitBody()),
        byok: { key: "sk-ant-outage0001" },
      });
      const { jobId } = (await response.json()) as { jobId: string };
      await claimAndRun();
      const job = getJob(jobId);
      if (job?.status !== "failed") throw new Error(`job ${job?.status}`);
      if (job.error?.includes("rejected your own key")) {
        throw new Error("a provider outage was blamed on the client key");
      }
      if (!job.error?.includes("500")) {
        throw new Error(`the real provider error was hidden: ${job.error}`);
      }
    },
    { policy: "allow", fakeStatus: 500, fakeErrorMessage: "internal error" },
  );
});

test("CORE-110: a setup failure after the key is registered drops the key", async () => {
  // The key is registered before the review/job/session rows are written. If
  // any of those writes throws, the job never reaches the queue and the
  // worker's `finally` never runs, so the submit path itself must drop the
  // key (review round 2, P2). A trigger forces the reviews insert to fail
  // deterministically.
  await withServer(
    async ({ app, token }) => {
      const db = getAppDb();
      db.exec(
        `CREATE TRIGGER fail_review_insert BEFORE INSERT ON reviews
         BEGIN SELECT RAISE(ABORT, 'boom'); END`,
      );
      try {
        let threw = false;
        try {
          await post(app, token, "/api/remote/reviews", {
            ...(await submitBody()),
            byok: { key: "sk-ant-setupfails0001" },
          });
        } catch {
          threw = true;
        }
        if (!threw) {
          throw new Error(
            "the submit should have failed on the reviews insert",
          );
        }
      } finally {
        db.exec("DROP TRIGGER fail_review_insert");
      }
      // The failed submit's key must not be left behind. No job id was ever
      // returned, so we assert on the size of the map: this test registered
      // exactly one key and its submit failed, so a non-zero count means the
      // key is still held (review round 2, P2).
      if (byokKeyCountForTest() !== 0) {
        throw new Error("a failed submit left its key in the process map");
      }
      // The failed submit's input row must be gone too: otherwise a retry
      // with the same request id would find a `billed_to = byok` row whose
      // key is gone and be told byok_key_lost (review round 4, P2).
      const retry = await post(app, token, "/api/remote/reviews", {
        ...(await submitBody()),
        byok: { key: "sk-ant-setupfails0001" },
      });
      const retried = (await retry.json()) as { error?: { code?: string } };
      if (retried.error?.code === "byok_key_lost") {
        throw new Error("a retry after a setup failure was rejected as lost");
      }
    },
    { policy: "allow" },
  );
});

test("CORE-110: a retry after a completed BYOK review stays idempotent", async () => {
  // A completed review deletes its remote_review_inputs row, so a retried
  // submit is treated as new rather than as a reclaim of the finished job.
  // This documents what an at-least-once client observes (review round 3).
  await withServer(
    async ({ app, token }) => {
      const body = {
        ...(await submitBody()),
        byok: { key: "sk-ant-completedretry0001" },
      };
      const first = await post(app, token, "/api/remote/reviews", body);
      const { jobId } = (await first.json()) as { jobId: string };
      await claimAndRun();
      if (getJob(jobId)?.status !== "done") {
        throw new Error(`first job ${getJob(jobId)?.status}`);
      }
      const retry = await post(app, token, "/api/remote/reviews", body);
      const retried = (await retry.json()) as {
        jobId?: string;
        error?: { code?: string };
      };
      if (retried.error?.code === "byok_key_lost") {
        throw new Error("a completed review must not report byok_key_lost");
      }
    },
    { policy: "allow" },
  );
});

test("CORE-110: a retry after a cancel is not blocked by a dead input row", async () => {
  // A queued review canceled while its key was in memory drops the key and the
  // input row. A client that retries the same request id must be free to
  // start over instead of finding a dead row whose key is gone and being told
  // byok_key_lost (review round 3).
  await withServer(
    async ({ app, token }) => {
      const body = {
        ...(await submitBody()),
        byok: { key: "sk-ant-cancelretry0001" },
      };
      const first = await post(app, token, "/api/remote/reviews", body);
      const { jobId } = (await first.json()) as { jobId: string };
      cancel(jobId, "dashboard_canceled");
      if (hasByokKey(jobId)) throw new Error("cancel should drop the key");

      const retry = await post(app, token, "/api/remote/reviews", body);
      const retried = (await retry.json()) as {
        jobId?: string;
        error?: { code?: string };
      };
      if (retried.error?.code === "byok_key_lost") {
        throw new Error("a retry after a cancel was rejected as key lost");
      }
    },
    { policy: "allow" },
  );
});

test("CORE-110: a failed job insert leaves no orphan review row", async () => {
  // The review and job rows are written in one transaction. If the job insert
  // fails, the review row must roll back rather than being left behind with no
  // job to run it (review round 5, P2).
  await withServer(
    async ({ app, token }) => {
      const db = getAppDb();
      const before = db
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM reviews")
        .get()?.n;
      db.exec(
        `CREATE TRIGGER fail_job_insert BEFORE INSERT ON jobs
         BEGIN SELECT RAISE(ABORT, 'boom'); END`,
      );
      try {
        let threw = false;
        try {
          await post(app, token, "/api/remote/reviews", {
            ...(await submitBody()),
            byok: { key: "sk-ant-jobfails0001" },
          });
        } catch {
          threw = true;
        }
        if (!threw) throw new Error("the submit should have failed");
      } finally {
        db.exec("DROP TRIGGER fail_job_insert");
      }
      const after = db
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM reviews")
        .get()?.n;
      if (after !== before) {
        throw new Error(
          `a failed job insert left ${(after ?? 0) - (before ?? 0)} review row(s)`,
        );
      }
      if (byokKeyCountForTest() !== 0) {
        throw new Error("a failed job insert left the key in memory");
      }
    },
    { policy: "allow" },
  );
});
