import { reposDir } from "../../config.ts";
import { createApp } from "../../server/app.ts";
import { sessionCookieHeader } from "../../server/auth.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { activateRepo, markKnowledgeBuilt } from "../../store/repos.ts";
import { createRemoteToken } from "../../services/remote_tokens.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  readTextFile,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../../testing/runtime.ts";
import { test } from "node:test";

const PASSWORD = "test-password";

async function withEnv(fn: () => Promise<void>): Promise<void> {
  const dbPath = `${tempDirSync()}/app.db`;
  const repos = `${tempDirSync()}/repos`;
  const prevDb = getEnv("CM_APP_DB");
  const prevRepos = getEnv("CM_REPOS_DIR");
  setEnv("CM_APP_DB", dbPath);
  setEnv("CM_REPOS_DIR", repos);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (prevDb === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", prevDb);
    if (prevRepos === undefined) deleteEnv("CM_REPOS_DIR");
    else setEnv("CM_REPOS_DIR", prevRepos);
  }
}

async function sessionCookie(
  app: ReturnType<typeof createApp>,
): Promise<string> {
  const login = await app.fetch(
    new Request("http://localhost/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "co-maintainer",
      },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  const body = await login.json();
  return sessionCookieHeader(body.token, false);
}

test("remote handshake succeeds without CSRF", async () => {
  await withEnv(async () => {
    const repo = "Owner/Repo";
    activateRepo(repo, undefined);
    markKnowledgeBuilt(repo, "abc");
    const guideDir = `${reposDir()}/${repo}`;
    await mkdirPath(guideDir, { recursive: true });
    await writeTextFile(`${guideDir}/PR_REVIEW_GUIDE.md`, "# Guide\n");
    const { token } = await createRemoteToken("cli");
    const app = createApp({ password: PASSWORD });
    const response = await app.fetch(
      new Request("http://localhost/api/remote/handshake", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          clientVersion: "0.3.0",
          repo: "owner/repo",
        }),
      }),
    );
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    const body = await response.json();
    if (body.repo?.fullName !== repo) {
      throw new Error(`canonical repo ${body.repo?.fullName}`);
    }
    if (body.token?.name !== "cli") throw new Error("token name");
  });
});

test("remote submit enqueues review and is idempotent", async () => {
  await withEnv(async () => {
    const repo = "Owner/Repo";
    activateRepo(repo, undefined);
    markKnowledgeBuilt(repo, "abc");
    const guideDir = `${reposDir()}/${repo}`;
    await mkdirPath(guideDir, { recursive: true });
    await writeTextFile(`${guideDir}/PR_REVIEW_GUIDE.md`, "# Guide\n");
    const { token } = await createRemoteToken("cli");
    const app = createApp({ password: PASSWORD });
    const submitBody = JSON.parse(
      await readTextFile(
        new URL("../fixtures/v1/submit.request.json", import.meta.url),
      ),
    );
    const post = () =>
      app.fetch(
        new Request("http://localhost/api/remote/reviews", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(submitBody),
        }),
      );
    const first = await post();
    if (first.status !== 202) {
      throw new Error(`submit: ${first.status} ${await first.text()}`);
    }
    const body1 = await first.json();
    const second = await post();
    const body2 = await second.json();
    if (body1.jobId !== body2.jobId || body1.reviewId !== body2.reviewId) {
      throw new Error("idempotent submit should return same ids");
    }
  });
});

test("dashboard can create remote tokens", async () => {
  await withEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const cookie = await sessionCookie(app);
    const response = await app.fetch(
      new Request("http://localhost/api/remote-tokens", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-requested-with": "co-maintainer",
        },
        body: JSON.stringify({ name: "ayse" }),
      }),
    );
    if (response.status !== 201) {
      throw new Error(`status ${response.status}`);
    }
    const body = await response.json();
    if (!body.token?.startsWith("cmr_")) {
      throw new Error("missing bearer token in response");
    }
  });
});
