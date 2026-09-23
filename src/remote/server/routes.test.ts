import { reposDir } from "../../config.ts";
import { createApp } from "../../server/app.ts";
import { sessionCookieHeader } from "../../server/auth.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { activateRepo, markKnowledgeBuilt } from "../../store/repos.ts";
import { createRemoteToken } from "../../services/remote_tokens.ts";
import { setRemoteTokenActive } from "../../store/remote_tokens.ts";
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

test("remote guides are read with a valid token and refused without one", async () => {
  await withEnv(async () => {
    const repo = "Owner/Repo";
    activateRepo(repo, undefined);
    markKnowledgeBuilt(repo, "abc");
    const guideDir = `${reposDir()}/${repo}`;
    await mkdirPath(guideDir, { recursive: true });
    await writeTextFile(`${guideDir}/SKILL.md`, "# Skill\n");
    await writeTextFile(`${guideDir}/PR_REVIEW_GUIDE.md`, "# Guide\n");
    const { token } = await createRemoteToken("cli");
    const app = createApp({ password: PASSWORD });

    const withToken = await app.fetch(
      new Request(
        `http://localhost/api/remote/guides?repo=${encodeURIComponent(repo)}`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
    );
    if (withToken.status !== 200) {
      throw new Error(`guides: ${withToken.status} ${await withToken.text()}`);
    }
    const body = (await withToken.json()) as {
      repo?: { fullName?: string };
      guides?: { file?: string; kind?: string; builtAt?: string }[];
    };
    if (body.repo?.fullName !== repo) {
      throw new Error(`canonical repo ${body.repo?.fullName}`);
    }
    const files = (body.guides ?? []).map((guide) => guide.file);
    // The reading order: skill first, then the review guide.
    if (files.join(",") !== "SKILL.md,PR_REVIEW_GUIDE.md") {
      throw new Error(`files ${files.join(",")}`);
    }
    const skill = body.guides?.[0];
    if (skill?.kind !== "skill" || !skill.builtAt) {
      throw new Error(`skill row ${JSON.stringify(skill)}`);
    }

    const anonymous = await app.fetch(
      new Request(
        `http://localhost/api/remote/guides?repo=${encodeURIComponent(repo)}`,
      ),
    );
    if (anonymous.status !== 401) {
      throw new Error(`anonymous: ${anonymous.status}`);
    }
  });
});

test("remote guides refuse a wrong repo and a path that escapes", async () => {
  await withEnv(async () => {
    const repo = "Owner/Repo";
    activateRepo(repo, undefined);
    markKnowledgeBuilt(repo, "abc");
    const guideDir = `${reposDir()}/${repo}`;
    await mkdirPath(guideDir, { recursive: true });
    await writeTextFile(`${guideDir}/SKILL.md`, "# Skill\n");
    const { token } = await createRemoteToken("cli");
    const app = createApp({ password: PASSWORD });
    const get = (repoQuery: string) =>
      app.fetch(
        new Request(
          `http://localhost/api/remote/guides?repo=${encodeURIComponent(repoQuery)}`,
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

    // A repo the server does not hold is a 404, not an empty list.
    const missing = await get("other/repo");
    if (missing.status !== 404) {
      throw new Error(`missing repo: ${missing.status}`);
    }
    // A traversal attempt never reaches the filesystem.
    const escaping = await get("../../../etc");
    if (escaping.status !== 400) {
      throw new Error(`escaping repo: ${escaping.status}`);
    }
  });
});

test("remote guides refuse an inactive token", async () => {
  await withEnv(async () => {
    const repo = "Owner/Repo";
    activateRepo(repo, undefined);
    markKnowledgeBuilt(repo, "abc");
    const guideDir = `${reposDir()}/${repo}`;
    await mkdirPath(guideDir, { recursive: true });
    await writeTextFile(`${guideDir}/SKILL.md`, "# Skill\n");
    const { id, token } = await createRemoteToken("cli");
    setRemoteTokenActive(id, false);
    const app = createApp({ password: PASSWORD });
    const response = await app.fetch(
      new Request(
        `http://localhost/api/remote/guides?repo=${encodeURIComponent(repo)}`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
    );
    if (response.status !== 403) {
      throw new Error(`inactive: ${response.status} ${await response.text()}`);
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
