import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import { registerHandler } from "../../services/jobs.ts";
import { getRepo } from "../../store/repos.ts";

const PASSWORD = "repos-api-test";

async function withTempEnv(fn: () => Promise<void>): Promise<void> {
  const originalConfig = Deno.env.get("CM_CONFIG_PATH");
  const originalDb = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_CONFIG_PATH", `${Deno.makeTempDirSync()}/config.json`);
  Deno.env.set("CM_APP_DB", `${Deno.makeTempDirSync()}/app.db`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    // A no-op handler: this test is about the HTTP -> enqueue wiring, not
    // about actually running init (that needs the network, see PLAN.md's
    // Live check for this phase).
    registerHandler("init", { run: () => Promise.resolve() });
    registerHandler("remake", { run: () => Promise.resolve() });
    await fn();
  } finally {
    await closeAppDb();
    if (originalConfig === undefined) Deno.env.delete("CM_CONFIG_PATH");
    else Deno.env.set("CM_CONFIG_PATH", originalConfig);
    if (originalDb === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", originalDb);
  }
}

async function loggedInApp() {
  const app = createApp({ password: PASSWORD });
  const loginResponse = await app.fetch(
    new Request("http://localhost/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "co-maintainer",
      },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  const { token } = await loginResponse.json();
  return (path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          "x-requested-with": "co-maintainer",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      }),
    );
}

Deno.test("POST /api/repos activates the repo and enqueues an init job", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    const response = await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/widgets" }),
    });
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    const { jobId } = await response.json();
    if (!jobId) throw new Error("no jobId returned");

    const listResponse = await authed("/api/repos");
    const { items } = await listResponse.json();
    if (
      !items.some((repo: { full_name: string }) =>
        repo.full_name === "acme/widgets"
      )
    ) {
      throw new Error("the repo did not appear in the active list");
    }

    const jobResponse = await authed(`/api/jobs/${jobId}`);
    const job = await jobResponse.json();
    if (job.type !== "init" || job.repo !== "acme/widgets") {
      throw new Error(`unexpected job: ${JSON.stringify(job)}`);
    }
  });
});

Deno.test("POST /api/repos rejects a malformed repo name before touching anything", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    const response = await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({ repo: "not-owner-slash-repo" }),
    });
    if (response.status !== 400) throw new Error(`status ${response.status}`);
  });
});

Deno.test("POST /api/repos/:owner/:repo/remake enqueues a remake job", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    const response = await authed("/api/repos/acme/widgets/remake", {
      method: "POST",
    });
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    const { jobId } = await response.json();
    const job = await (await authed(`/api/jobs/${jobId}`)).json();
    if (job.type !== "remake" || job.repo !== "acme/widgets") {
      throw new Error(`unexpected job: ${JSON.stringify(job)}`);
    }
  });
});

Deno.test("PATCH /api/repos stores reviewScope", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/widgets" }),
    });
    const response = await authed("/api/repos/acme/widgets", {
      method: "PATCH",
      body: JSON.stringify({ reviewScope: "incremental" }),
    });
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    if (getRepo("acme/widgets")?.review_scope !== "incremental") {
      throw new Error("review_scope did not stick");
    }
  });
});
