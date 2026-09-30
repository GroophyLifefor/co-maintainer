import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { readConfig, writeUserConfig } from "../../config.ts";
import { registerHandler } from "../../services/jobs.ts";
import { getRepo, updateRepoSettings } from "../../store/repos.ts";
import { TEST_PKCS1_PEM } from "../../testing/fixtures/rsa_key.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { test } from "node:test";

const PASSWORD = "repos-api-test";

async function withTempEnv(fn: () => Promise<void>): Promise<void> {
  const originalConfig = getEnv("CM_CONFIG_PATH");
  const originalDb = getEnv("CM_APP_DB");
  setEnv("CM_CONFIG_PATH", `${tempDirSync()}/config.json`);
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
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
    if (originalConfig === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", originalConfig);
    if (originalDb === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", originalDb);
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

test("POST /api/repos activates the repo and enqueues an init job", async () => {
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
      !items.some(
        (repo: { full_name: string }) => repo.full_name === "acme/widgets",
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

test("POST /api/repos rejects a malformed repo name before touching anything", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    const response = await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({ repo: "not-owner-slash-repo" }),
    });
    if (response.status !== 400) throw new Error(`status ${response.status}`);
  });
});

/** Stubs the App-level GitHub calls the preview makes: one installation, the
 * repo, a small pull request list, one detail each and a commit list. */
function stubGithub(fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/app/installations")) {
      return Response.json([
        {
          id: 7,
          account: { login: "acme", type: "Organization" },
          suspended_at: null,
        },
      ]);
    }
    if (url.includes("/access_tokens")) {
      return Response.json({
        token: "ghs_x",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (url.includes("/installation/repositories")) {
      return Response.json({
        repositories: [{ full_name: "acme/widgets", private: false }],
      });
    }
    if (url.match(/\/repos\/acme\/widgets\/pulls\?/)) {
      return Response.json([
        {
          number: 1,
          title: "First",
          updated_at: "2026-01-02T00:00:00Z",
          additions: 10,
          deletions: 5,
        },
      ]);
    }
    if (url.match(/\/repos\/acme\/widgets\/pulls\/1$/)) {
      return Response.json({ number: 1, additions: 10, deletions: 5 });
    }
    if (url.includes("/repos/acme/widgets/releases")) return Response.json([]);
    if (url.includes("/repos/acme/widgets/commits")) return Response.json([]);
    if (url.match(/\/repos\/acme\/widgets$/)) {
      return Response.json({ default_branch: "main", has_issues: true });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("POST /api/repos/preview returns a plan and does not add the repo", async () => {
  await withTempEnv(async () => {
    await writeUserConfig({
      auth: "gh",
      ai: "none",
      githubAppId: "4900449",
      githubAppPrivateKey: TEST_PKCS1_PEM,
    });
    const authed = await loggedInApp();
    await stubGithub(async () => {
      const response = await authed("/api/repos/preview", {
        method: "POST",
        body: JSON.stringify({ repo: "acme/widgets" }),
      });
      if (response.status !== 200) {
        throw new Error(`status ${response.status}: ${await response.text()}`);
      }
      const body = await response.json();
      if (!String(body.command).startsWith("co-maintainer init acme/widgets")) {
        throw new Error(`unexpected command: ${body.command}`);
      }
      if (!body.patch || body.patch.includeCodebase !== true) {
        throw new Error(`unexpected patch: ${JSON.stringify(body.patch)}`);
      }
      if (!body.estimate || typeof body.estimate.extract !== "number") {
        throw new Error("the preview omitted the estimate");
      }
      if (getRepo("acme/widgets")) {
        throw new Error("the preview added the repo");
      }
    });
  });
});

test("POST /api/repos/preview refuses without a GitHub App", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    const response = await authed("/api/repos/preview", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/widgets" }),
    });
    if (response.status !== 422) throw new Error(`status ${response.status}`);
  });
});

test("POST /api/repos with a patch stores the confirmed plan first", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    const response = await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({
        repo: "acme/widgets",
        patch: { includeCommitHistory: false, maxPrMonths: 24 },
      }),
    });
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    const stored = readConfig().repos?.["acme/widgets"];
    if (stored?.includeCommitHistory !== false || stored?.maxPrMonths !== 24) {
      throw new Error(`the patch was not stored: ${JSON.stringify(stored)}`);
    }
    if (!getRepo("acme/widgets")) throw new Error("the repo was not added");
  });
});

test("POST /api/repos/:owner/:repo/remake enqueues a remake job", async () => {
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

test("PATCH /api/repos stores reviewScope", async () => {
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

async function patchRepo(
  authed: Awaited<ReturnType<typeof loggedInApp>>,
  body: unknown,
) {
  return await authed("/api/repos/acme/widgets", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

test("PATCH /api/repos pins a repository to the old switches the first time one is used", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/widgets" }),
    });
    if (getRepo("acme/widgets")?.review_policy_json !== null) {
      throw new Error("a new repository starts without a stored policy");
    }
    const response = await patchRepo(authed, { autoReview: false });
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    const row = getRepo("acme/widgets");
    if (row?.auto_review !== 0 || row.review_policy_json !== '"legacy"') {
      throw new Error(JSON.stringify(row));
    }
  });
});

test("PATCH /api/repos refuses the old switches on a repository with a real policy", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/widgets" }),
    });
    updateRepoSettings("acme/widgets", {
      review_policy_json: JSON.stringify("trusted-auto"),
    });
    const response = await patchRepo(authed, { skipDrafts: false });
    if (response.status !== 409) throw new Error(`status ${response.status}`);
    const body = await response.json();
    if (body.error?.code !== "policy_in_use") {
      throw new Error(JSON.stringify(body));
    }
    const row = getRepo("acme/widgets");
    if (row?.skip_drafts !== 1 || row.review_policy_json !== '"trusted-auto"') {
      throw new Error(`nothing may change: ${JSON.stringify(row)}`);
    }
    const other = await patchRepo(authed, { reviewScope: "incremental" });
    if (other.status !== 200) {
      throw new Error("settings that are not a switch still save");
    }
  });
});

test("PATCH /api/repos saves a remake schedule and clears it again", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/widgets" }),
    });
    const saved = await patchRepo(authed, { remakeCron: " 30 4 * * 1 " });
    if (saved.status !== 200) throw new Error(`status ${saved.status}`);
    if (readConfig().repos?.["acme/widgets"]?.remakeCron !== "30 4 * * 1") {
      throw new Error("the schedule was not stored trimmed");
    }
    await patchRepo(authed, { autoReview: false });
    if (!readConfig().repos?.["acme/widgets"]?.remakeCron) {
      throw new Error("an unrelated save cleared the schedule");
    }
    const cleared = await patchRepo(authed, { remakeCron: null });
    if (cleared.status !== 200) throw new Error(`status ${cleared.status}`);
    if (readConfig().repos?.["acme/widgets"]?.remakeCron !== undefined) {
      throw new Error("the schedule was not cleared");
    }
  });
});

test("PATCH /api/repos rejects a bad schedule without applying anything", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/widgets" }),
    });
    for (const remakeCron of ["nonsense", "* * * * *", 5]) {
      const response = await patchRepo(authed, {
        remakeCron,
        reviewScope: "incremental",
      });
      if (response.status !== 422) {
        throw new Error(`${remakeCron}: status ${response.status}`);
      }
      const body = await response.json();
      if (body.error?.code !== "invalid_cron") {
        throw new Error(`unexpected error ${JSON.stringify(body)}`);
      }
    }
    if (getRepo("acme/widgets")?.review_scope === "incremental") {
      throw new Error("a rejected request still changed the repo");
    }
  });
});

test("PATCH /api/repos stores a policy, normalises a template and can go back to the switches", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/widgets" }),
    });
    const template = await patchRepo(authed, { reviewPolicy: "trusted-auto" });
    if (template.status !== 200) throw new Error(`status ${template.status}`);
    if (getRepo("acme/widgets")?.review_policy_json !== '"trusted-auto"') {
      throw new Error(String(getRepo("acme/widgets")?.review_policy_json));
    }
    const custom = await patchRepo(authed, {
      reviewPolicy: {
        rules: [
          {
            name: "newcomers",
            when: { association: ["NONE"] },
            action: "skip",
          },
        ],
        default: "review",
        maxRounds: 3,
      },
    });
    if (custom.status !== 200) throw new Error(`status ${custom.status}`);
    const stored = JSON.parse(
      getRepo("acme/widgets")?.review_policy_json ?? "null",
    ) as { maxRounds?: number; rules?: unknown[] };
    if (stored.maxRounds !== 3 || stored.rules?.length !== 1) {
      throw new Error(JSON.stringify(stored));
    }
    const back = await patchRepo(authed, { reviewPolicy: "legacy" });
    if (back.status !== 200) throw new Error(`status ${back.status}`);
    if (getRepo("acme/widgets")?.review_policy_json !== '"legacy"') {
      throw new Error("the repository did not go back to the switches");
    }
    const inherit = await patchRepo(authed, { reviewPolicy: null });
    if (inherit.status !== 200) throw new Error(`status ${inherit.status}`);
    if (getRepo("acme/widgets")?.review_policy_json !== null) {
      throw new Error("null means follow the server default");
    }
  });
});

test("PATCH /api/repos refuses a policy it cannot read and changes nothing", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/widgets" }),
    });
    const response = await patchRepo(authed, {
      reviewPolicy: { rules: [{ when: { fork: "yes" }, action: "skip" }] },
      reviewScope: "incremental",
    });
    if (response.status !== 422) throw new Error(`status ${response.status}`);
    const body = await response.json();
    if (
      body.error?.code !== "invalid_policy" ||
      !/fork/.test(body.error.message)
    ) {
      throw new Error(JSON.stringify(body));
    }
    const row = getRepo("acme/widgets");
    if (row?.review_policy_json !== null || row.review_scope !== "whole-pr") {
      throw new Error(`nothing may change: ${JSON.stringify(row)}`);
    }
  });
});

test("PATCH /api/repos lets a policy and the switches travel together only when they agree", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/widgets" }),
    });
    const conflict = await patchRepo(authed, {
      reviewPolicy: "trusted-auto",
      autoReview: false,
    });
    if (conflict.status !== 409) throw new Error(`status ${conflict.status}`);
    const together = await patchRepo(authed, {
      reviewPolicy: "legacy",
      autoReview: false,
    });
    if (together.status !== 200) throw new Error(`status ${together.status}`);
    const row = getRepo("acme/widgets");
    if (row?.review_policy_json !== '"legacy"' || row.auto_review !== 0) {
      throw new Error(JSON.stringify(row));
    }
  });
});

test("POST /api/repos stores the chosen policy, and refuses a bad one before adding anything", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    const bad = await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/widgets", reviewPolicy: "nope" }),
    });
    if (bad.status !== 422) throw new Error(`status ${bad.status}`);
    if (getRepo("acme/widgets") !== undefined) {
      throw new Error("a refused policy must not leave a repository behind");
    }
    const good = await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({
        repo: "acme/widgets",
        reviewPolicy: "on-request-only",
      }),
    });
    if (good.status !== 200) throw new Error(`status ${good.status}`);
    if (getRepo("acme/widgets")?.review_policy_json !== '"on-request-only"') {
      throw new Error(String(getRepo("acme/widgets")?.review_policy_json));
    }
    const legacy = await authed("/api/repos", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/other", reviewPolicy: "legacy" }),
    });
    if (legacy.status !== 422) {
      throw new Error("a new repository cannot start on the simple switches");
    }
  });
});

test("POST /api/repos/policy-preview describes a policy in plain sentences", async () => {
  await withTempEnv(async () => {
    const authed = await loggedInApp();
    const ok = await authed("/api/repos/policy-preview", {
      method: "POST",
      body: JSON.stringify({ policy: "trusted-auto" }),
    });
    if (ok.status !== 200) throw new Error(`status ${ok.status}`);
    const { summary } = (await ok.json()) as { summary: string[] };
    if (
      !summary.includes(
        "Any other pull request waits for a maintainer request.",
      )
    ) {
      throw new Error(JSON.stringify(summary));
    }
    const bad = await authed("/api/repos/policy-preview", {
      method: "POST",
      body: JSON.stringify({ policy: { maxRounds: 0 } }),
    });
    if (bad.status !== 422) throw new Error(`status ${bad.status}`);
  });
});
