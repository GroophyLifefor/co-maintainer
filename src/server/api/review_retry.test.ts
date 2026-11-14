/** "Retry with the same model" must really reuse the model that failed: the
 * page sends it, the API keeps it on the new job, and the review job runs
 * with it instead of whatever the config says now. */
import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import { activateRepo } from "../../store/repos.ts";
import { getJob } from "../../store/jobs.ts";
import { reviewOptionsForJob } from "../../services/review.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { test } from "node:test";
import { isolateTestFile } from "../../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

const PASSWORD = "review-retry-pass";

async function withApp(
  fn: (post: (body?: unknown) => Promise<Response>) => Promise<void>,
): Promise<void> {
  const keys = ["CM_APP_DB", "CM_CONFIG_PATH"];
  const original = keys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_APP_DB", `${dir}/app.db`);
  try {
    await openAppDb();
    await writeUserConfig({
      auth: "gh",
      ai: "openrouter",
      token: "k",
      highModel: "config/now",
      lowModel: "config/low",
    });
    activateRepo("acme/widgets", 9);
    const app = createApp({ password: PASSWORD });
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
    const { token } = await login.json();
    await fn((body) =>
      app.fetch(
        new Request("http://localhost/api/repos/acme/widgets/pulls/7/review", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-requested-with": "co-maintainer",
            authorization: `Bearer ${token}`,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      ),
    );
  } finally {
    await closeAppDb();
    keys.forEach((key, i) => {
      const value = original[i];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    });
    await removePath(dir, { recursive: true }).catch(() => {});
  }
}

async function jobArgs(response: Response): Promise<Record<string, unknown>> {
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  const { jobId } = (await response.json()) as { jobId: string };
  return JSON.parse(getJob(jobId)?.args ?? "{}");
}

test("a retry that names a model keeps it on the new job", async () => {
  await withApp(async (post) => {
    const args = await jobArgs(await post({ model: "failed/model" }));
    if (args.model !== "failed/model") throw new Error(JSON.stringify(args));
  });
});

test("a review started without a model keeps using the config", async () => {
  await withApp(async (post) => {
    const args = await jobArgs(await post());
    if ("model" in args) throw new Error(JSON.stringify(args));
  });
});

test("a model that is not a short string is refused", async () => {
  await withApp(async (post) => {
    for (const model of [42, "", "x".repeat(300)]) {
      const response = await post({ model });
      if (response.status !== 422) {
        throw new Error(`${JSON.stringify(model)}: status ${response.status}`);
      }
    }
  });
});

test("the review job runs with the job's model over the config's", async () => {
  await withApp(async () => {
    const pinned = reviewOptionsForJob("acme/widgets", 7, {
      model: "failed/model",
    });
    if (pinned.highModel !== "failed/model") {
      throw new Error(`pinned: ${pinned.highModel}`);
    }
    const plain = reviewOptionsForJob("acme/widgets", 7, {});
    if (plain.highModel !== "config/now") {
      throw new Error(`plain: ${plain.highModel}`);
    }
  });
});
