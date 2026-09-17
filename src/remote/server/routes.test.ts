import { reposDir } from "../../config.ts";
import { createApp } from "../../server/app.ts";
import { sessionCookieHeader } from "../../server/auth.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { activateRepo, markKnowledgeBuilt } from "../../store/repos.ts";
import { createRemoteToken } from "../../services/remote_tokens.ts";

const PASSWORD = "test-password";

async function withEnv(
  fn: () => Promise<void>,
): Promise<void> {
  const dbPath = `${Deno.makeTempDirSync()}/app.db`;
  const repos = `${Deno.makeTempDirSync()}/repos`;
  const prevDb = Deno.env.get("CM_APP_DB");
  const prevRepos = Deno.env.get("CM_REPOS_DIR");
  Deno.env.set("CM_APP_DB", dbPath);
  Deno.env.set("CM_REPOS_DIR", repos);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (prevDb === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", prevDb);
    if (prevRepos === undefined) Deno.env.delete("CM_REPOS_DIR");
    else Deno.env.set("CM_REPOS_DIR", prevRepos);
  }
}

async function sessionCookie(app: ReturnType<typeof createApp>): Promise<string> {
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

Deno.test("remote handshake succeeds without CSRF", async () => {
  await withEnv(async () => {
    const repo = "Owner/Repo";
    activateRepo(repo, undefined);
    markKnowledgeBuilt(repo, "abc");
    const guideDir = `${reposDir()}/${repo}`;
    await Deno.mkdir(guideDir, { recursive: true });
    await Deno.writeTextFile(
      `${guideDir}/PR_REVIEW_GUIDE.md`,
      "# Guide\n",
    );
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

Deno.test("dashboard can create remote tokens", async () => {
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
