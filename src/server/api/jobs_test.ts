import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { enqueue } from "../../services/jobs.ts";

const PASSWORD = "jobs-api-test";

async function withTempDb(fn: () => Promise<void>): Promise<void> {
  const original = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_APP_DB", `${Deno.makeTempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", original);
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
  const authed = (path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          "x-requested-with": "co-maintainer",
          authorization: `Bearer ${token}`,
          ...(init.headers as Record<string, string> | undefined),
        },
      }),
    );
  return authed;
}

async function readSse(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

Deno.test("GET /api/jobs lists queued jobs, GET /api/jobs/:id returns detail with logs", async () => {
  await withTempDb(async () => {
    const authed = await loggedInApp();
    const { id } = enqueue({ type: "unused", repo: "a/b" });

    const listResponse = await authed("/api/jobs");
    const list = await listResponse.json();
    if (!list.items.some((job: { id: string }) => job.id === id)) {
      throw new Error("the enqueued job did not appear in the listing");
    }

    const detailResponse = await authed(`/api/jobs/${id}`);
    const detail = await detailResponse.json();
    if (detail.id !== id || detail.status !== "queued") {
      throw new Error(`unexpected job detail: ${JSON.stringify(detail)}`);
    }
    if (!Array.isArray(detail.logs)) {
      throw new Error("detail did not include logs");
    }

    const missingResponse = await authed("/api/jobs/does-not-exist");
    if (missingResponse.status !== 404) {
      throw new Error("an unknown job id did not 404");
    }
  });
});

Deno.test("POST /api/jobs/:id/cancel cancels a queued job", async () => {
  await withTempDb(async () => {
    const authed = await loggedInApp();
    const { id } = enqueue({ type: "unused", repo: "a/b" });

    const cancelResponse = await authed(`/api/jobs/${id}/cancel`, {
      method: "POST",
    });
    const result = await cancelResponse.json();
    if (result.ok !== true) {
      throw new Error("cancel reported ok:false for a queued job");
    }

    const detail = await (await authed(`/api/jobs/${id}`)).json();
    if (detail.status !== "canceled") {
      throw new Error("job was not actually canceled");
    }
  });
});

Deno.test("GET /api/jobs/:id/logs/stream replays existing lines then closes for a finished job", async () => {
  await withTempDb(async () => {
    const authed = await loggedInApp();
    const { id } = enqueue({ type: "unused", repo: "a/b" });
    // Finish it out from under the stream so it has history but nothing live.
    const { setJobStatus } = await import("../../store/jobs.ts");
    const { appendLog } = await import("../../store/job_logs.ts");
    appendLog(id, "info", "first line");
    appendLog(id, "info", "second line");
    setJobStatus(id, "done");

    const streamResponse = await authed(`/api/jobs/${id}/logs/stream`);
    if (streamResponse.headers.get("content-type") !== "text/event-stream") {
      throw new Error("wrong content-type for the stream");
    }
    const text = await readSse(streamResponse);
    if (!text.includes("first line") || !text.includes("second line")) {
      throw new Error(`stream did not replay both lines: ${text}`);
    }

    // Resuming from the first seq should replay only the second line.
    const resumed = await readSse(
      await authed(`/api/jobs/${id}/logs/stream?from=1`),
    );
    if (resumed.includes("first line") || !resumed.includes("second line")) {
      throw new Error(`resume did not skip the first line: ${resumed}`);
    }
  });
});
