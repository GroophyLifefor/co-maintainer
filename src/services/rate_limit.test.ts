import { mock, test } from "node:test";
import { AiBatch } from "../ai/batch.ts";
import { githubFetch } from "../github/client.ts";
import { handleJobsRoute } from "../server/api/jobs.ts";
import { closeAppDb, getAppDb, openAppDb } from "../store/app_db.ts";
import { appendLog } from "../store/job_logs.ts";
import { getJob, insertJob, setJobStatus } from "../store/jobs.ts";
import { writeUserConfig } from "../config.ts";
import { claimAndRun, enqueue, getLogsSince, registerHandler } from "./jobs.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import type { AiProvider, AiResponse } from "../types.ts";
import { isolateTestFile } from "../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

const WAIT_LOG_TYPE = "rate_limit_wait";

type WaitService = "openrouter" | "github";

type WaitRecord = {
  jobId: string;
  service: WaitService;
  stage: string;
  reason: string;
  seconds: number;
  at: string;
};

type WaitInput = {
  service: WaitService;
  stage: string;
  reason: string;
  seconds: number;
};

type WaitSummary = {
  count: number;
  totalSeconds: number;
};

async function withTempDb(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "CM_APP_DB",
    "CM_CONFIG_PATH",
    "CM_REPOS_DIR",
    "XDG_CACHE_HOME",
  ] as const;
  const original: Record<string, string | undefined> = {};
  for (const key of keys) original[key] = getEnv(key);
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  setEnv("XDG_CACHE_HOME", `${dir}/cache`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    await fn();
  } finally {
    await closeAppDb();
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    }
  }
}

function appendWait(jobId: string, wait: WaitInput): void {
  appendLog(
    jobId,
    "warn",
    JSON.stringify({
      type: WAIT_LOG_TYPE,
      service: wait.service,
      stage: wait.stage,
      reason: wait.reason,
      seconds: wait.seconds,
    }),
  );
}

function parseWaitLogs(jobId: string): WaitRecord[] {
  return getLogsSince(jobId).flatMap((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.message);
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== "object") return [];
    const record = parsed as Record<string, unknown>;
    if (record.type !== WAIT_LOG_TYPE) return [];
    return [
      {
        jobId,
        service: record.service as WaitService,
        stage: String(record.stage ?? ""),
        reason: String(record.reason ?? ""),
        seconds: Number(record.seconds),
        at: line.at,
      },
    ];
  });
}

async function jobDetail(id: string): Promise<Record<string, unknown>> {
  const url = new URL(`http://localhost/api/jobs/${id}`);
  const response = handleJobsRoute(new Request(url), url);
  if (response.status !== 200) {
    throw new Error(`GET /api/jobs/${id} returned ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function waitsOf(detail: Record<string, unknown>): WaitRecord[] {
  const waits = detail.rateLimitWaits;
  if (!Array.isArray(waits)) {
    throw new Error("the job detail has no rateLimitWaits list");
  }
  return waits as WaitRecord[];
}

function summaryOf(detail: Record<string, unknown>): WaitSummary {
  const summary = detail.rateLimitWaitSummary;
  if (!summary || typeof summary !== "object") {
    throw new Error("the job detail has no rateLimitWaitSummary");
  }
  return summary as WaitSummary;
}

function aiResponse(): AiResponse {
  return {
    text: "ok",
    tokensIn: 1,
    tokensOut: 1,
    model: "mock",
    provider: "openrouter",
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Resolved by a fake provider or fetch on its first call. Before that call the
 * job reads files and hashes its request on the thread pool, so no fixed
 * number of event loop turns is sure to be enough on a busy machine. */
function firstCallSignal(): { called: Promise<void>; fire: () => void } {
  let fire = () => {};
  const called = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { called, fire };
}

/** Waits for the first attempt, and fails at once if the job ends without
 * making one instead of waiting forever. */
async function waitForFirstCall(
  called: Promise<void>,
  running: Promise<unknown>,
  label: string,
): Promise<void> {
  const ended = await Promise.race([
    called.then(() => false),
    running.then(() => true),
  ]);
  if (ended) throw new Error(`the job ended before ${label}`);
}

/** The retry wait is recorded in the same synchronous step that starts its
 * timer, so a recorded wait means a tick will reach the timer. */
function assertWaitStarted(id: string): void {
  if (parseWaitLogs(id).length !== 1) {
    throw new Error("the job did not start its retry wait");
  }
}

/** Lets the job finish before withTempDb closes app.db. When a check above
 * fails, the job is still waiting on a mocked timer, and if the test left it
 * there it would write to the closed database after the test ended. */
async function settle(running: Promise<unknown>): Promise<void> {
  let done = false;
  void running.then(
    () => (done = true),
    () => (done = true),
  );
  const deadline = performance.now() + 10_000;
  while (!done && performance.now() < deadline) {
    mock.timers.runAll();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function retryDelay(attempt: number): number {
  if (attempt === 1) return 5_000;
  if (attempt === 2) return 15_000;
  if (attempt === 3) return 30_000;
  return 45_000;
}

test("a job lists each rate-limit wait with its service, stage, reason, applied seconds and time", async () => {
  await withTempDb(async () => {
    insertJob({ id: "job-waits", type: "remake", repo: "acme/widgets" });
    appendWait("job-waits", {
      service: "openrouter",
      stage: "extract facts",
      reason: "429 Too Many Requests",
      seconds: 5,
    });
    appendWait("job-waits", {
      service: "openrouter",
      stage: "extract facts",
      reason: "429 Too Many Requests",
      seconds: 15,
    });
    appendWait("job-waits", {
      service: "github",
      stage: "read pull requests",
      reason: "secondary rate limit",
      seconds: 30,
    });
    insertJob({ id: "job-other", type: "remake", repo: "acme/widgets" });
    appendWait("job-other", {
      service: "github",
      stage: "read pull requests",
      reason: "secondary rate limit",
      seconds: 60,
    });

    const detail = await jobDetail("job-waits");
    const waits = waitsOf(detail);
    if (waits.length !== 3) {
      throw new Error(`expected 3 wait records, got ${waits.length}`);
    }
    for (const wait of waits) {
      if (wait.jobId !== "job-waits") {
        throw new Error(`a wait from ${wait.jobId} leaked into this job`);
      }
      if (wait.service !== "openrouter" && wait.service !== "github") {
        throw new Error(`unknown service on a wait record: ${wait.service}`);
      }
      if (!wait.stage || !wait.reason) {
        throw new Error("a wait record lost its stage or reason");
      }
      if (!Number.isFinite(wait.seconds) || wait.seconds <= 0) {
        throw new Error(
          `a wait record has no applied seconds: ${wait.seconds}`,
        );
      }
      if (!wait.at || Number.isNaN(Date.parse(wait.at))) {
        throw new Error(`a wait record has no usable time: ${wait.at}`);
      }
    }
    const seconds = waits.map((wait) => wait.seconds).sort((a, b) => a - b);
    if (seconds.join(",") !== "5,15,30") {
      throw new Error(
        `two different wait durations were collapsed: ${seconds.join(",")}`,
      );
    }
  });
});

test("summarizing a job counts each wait and adds two different durations instead of collapsing them", async () => {
  await withTempDb(async () => {
    insertJob({ id: "job-summary", type: "remake", repo: "acme/widgets" });
    appendWait("job-summary", {
      service: "openrouter",
      stage: "extract facts",
      reason: "429 Too Many Requests",
      seconds: 5,
    });
    appendWait("job-summary", {
      service: "openrouter",
      stage: "extract facts",
      reason: "429 Too Many Requests",
      seconds: 15,
    });
    appendWait("job-summary", {
      service: "github",
      stage: "read pull requests",
      reason: "secondary rate limit",
      seconds: 30,
    });

    const detail = await jobDetail("job-summary");
    const summary = summaryOf(detail);
    if (summary.count !== 3) {
      throw new Error(`expected 3 waits in the summary, got ${summary.count}`);
    }
    if (summary.totalSeconds !== 50) {
      throw new Error(
        `expected the summary total to be 50 seconds, got ${summary.totalSeconds}`,
      );
    }
    const seconds = waitsOf(detail)
      .map((wait) => wait.seconds)
      .sort((a, b) => a - b);
    if (seconds.join(",") !== "5,15,30") {
      throw new Error(
        `the summary collapsed two different durations: ${seconds.join(",")}`,
      );
    }
  });
});

test("the AI 429 backoff records its wait and still succeeds when the provider recovers", async () => {
  await withTempDb(async () => {
    let calls = 0;
    const first = firstCallSignal();
    const provider: AiProvider = {
      async complete() {
        calls++;
        if (calls === 1) {
          first.fire();
          throw new Error(
            "OpenRouter failed with 429: provider is rate limiting",
          );
        }
        return aiResponse();
      },
    };
    registerHandler("test-ai-rate-limit", {
      async run() {
        const batch = new AiBatch(
          provider,
          `rate-limit-ai-${crypto.randomUUID()}`,
          1,
          "test-profile",
        );
        await batch.run([{ job: "extract_unit", prompt: "p", maxTokens: 10 }]);
      },
    });

    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let running: Promise<boolean> | undefined;
    try {
      const { id } = enqueue({
        type: "test-ai-rate-limit",
        repo: "acme/widgets",
      });
      running = claimAndRun();
      await waitForFirstCall(first.called, running, "the first AI attempt");
      await flush();
      if (getJob(id)?.status !== "running") {
        throw new Error(
          `the job left running before the wait: ${getJob(id)?.status}`,
        );
      }
      assertWaitStarted(id);

      mock.timers.tick(retryDelay(1));
      await flush();
      await running;

      if (Number(calls) !== 2) {
        throw new Error(`expected one retry, got ${calls} calls`);
      }
      if (getJob(id)?.status !== "done") {
        throw new Error(`the job did not succeed: ${getJob(id)?.status}`);
      }
      const waits = parseWaitLogs(id);
      if (waits.length !== 1) {
        throw new Error(`expected 1 recorded AI wait, got ${waits.length}`);
      }
      const wait = waits[0]!;
      if (wait.service !== "openrouter") {
        throw new Error(`the AI wait was recorded as ${wait.service}`);
      }
      if (wait.seconds !== 5) {
        throw new Error(`the AI wait recorded ${wait.seconds} seconds, want 5`);
      }
      if (!wait.stage || !wait.reason) {
        throw new Error("the AI wait lost its stage or reason");
      }
      if (!wait.at || Number.isNaN(Date.parse(wait.at))) {
        throw new Error(`the AI wait has no usable time: ${wait.at}`);
      }
    } finally {
      if (running) await settle(running);
      mock.timers.reset();
    }
  });
});

async function runGithubRetry(
  status: 403 | 429,
): Promise<{ id: string; calls: number }> {
  let calls = 0;
  const first = firstCallSignal();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) first.fire();
    return calls === 1
      ? new Response("{}", {
          status,
          headers: { "retry-after": "4" },
        })
      : new Response("{}", { status: 200 });
  };
  registerHandler("test-github-rate-limit", {
    async run() {
      await githubFetch("https://api.github.com/x", {});
    },
  });

  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let running: Promise<boolean> | undefined;
  try {
    const { id } = enqueue({
      type: "test-github-rate-limit",
      repo: "acme/widgets",
    });
    running = claimAndRun();
    await waitForFirstCall(first.called, running, "the first GitHub request");
    await flush();
    if (calls !== 1) {
      throw new Error(`expected the first GitHub request, got ${calls} calls`);
    }
    if (getJob(id)?.status !== "running") {
      throw new Error(
        `the GitHub job left running before the wait: ${getJob(id)?.status}`,
      );
    }
    assertWaitStarted(id);

    mock.timers.tick(4_000);
    await flush();
    await running;
    return { id, calls };
  } finally {
    if (running) await settle(running);
    mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
}

test("the GitHub 403 retry records its wait and still succeeds when the service recovers", async () => {
  await withTempDb(async () => {
    const { id, calls } = await runGithubRetry(403);
    if (calls !== 2) {
      throw new Error(`expected one GitHub retry, got ${calls} calls`);
    }
    if (getJob(id)?.status !== "done") {
      throw new Error(`the GitHub job did not succeed: ${getJob(id)?.status}`);
    }
    const waits = parseWaitLogs(id);
    if (waits.length !== 1) {
      throw new Error(`expected 1 recorded GitHub wait, got ${waits.length}`);
    }
    const wait = waits[0]!;
    if (wait.service !== "github") {
      throw new Error(`the GitHub wait was recorded as ${wait.service}`);
    }
    if (wait.seconds !== 4) {
      throw new Error(
        `the GitHub wait recorded ${wait.seconds} seconds, want 4`,
      );
    }
    if (!wait.stage || !wait.reason) {
      throw new Error("the GitHub wait lost its stage or reason");
    }
    if (!wait.at || Number.isNaN(Date.parse(wait.at))) {
      throw new Error(`the GitHub wait has no usable time: ${wait.at}`);
    }
  });
});

test("the GitHub 429 retry records its wait and still succeeds when the service recovers", async () => {
  await withTempDb(async () => {
    const { id, calls } = await runGithubRetry(429);
    if (calls !== 2) {
      throw new Error(`expected one GitHub retry, got ${calls} calls`);
    }
    if (getJob(id)?.status !== "done") {
      throw new Error(`the GitHub job did not succeed: ${getJob(id)?.status}`);
    }
    const waits = parseWaitLogs(id);
    if (waits.length !== 1) {
      throw new Error(`expected 1 recorded GitHub wait, got ${waits.length}`);
    }
    const wait = waits[0]!;
    if (wait.service !== "github") {
      throw new Error(`the GitHub wait was recorded as ${wait.service}`);
    }
    if (wait.seconds !== 4) {
      throw new Error(
        `the GitHub wait recorded ${wait.seconds} seconds, want 4`,
      );
    }
  });
});

test("wait records survive a store reopen and the total is the sum of waits, not the job duration", async () => {
  await withTempDb(async () => {
    insertJob({ id: "job-reopen", type: "remake", repo: "acme/widgets" });
    setJobStatus("job-reopen", "done");
    getAppDb()
      .prepare(`UPDATE jobs SET started_at = ?, finished_at = ? WHERE id = ?`)
      .run(
        "2026-01-02T00:00:00.000Z",
        "2026-01-02T00:09:00.000Z",
        "job-reopen",
      );
    appendWait("job-reopen", {
      service: "openrouter",
      stage: "extract facts",
      reason: "429 Too Many Requests",
      seconds: 5,
    });
    appendWait("job-reopen", {
      service: "openrouter",
      stage: "extract facts",
      reason: "429 Too Many Requests",
      seconds: 15,
    });
    appendWait("job-reopen", {
      service: "github",
      stage: "read pull requests",
      reason: "secondary rate limit",
      seconds: 30,
    });

    const before = parseWaitLogs("job-reopen");
    if (before.length !== 3) {
      throw new Error(
        `expected 3 waits before reopening, got ${before.length}`,
      );
    }

    await closeAppDb();
    await openAppDb();

    const after = parseWaitLogs("job-reopen");
    if (after.length !== 3) {
      throw new Error(`the reopen lost wait records: ${after.length} left`);
    }
    const detail = await jobDetail("job-reopen");
    const summary = summaryOf(detail);
    if (summary.count !== 3) {
      throw new Error(`expected 3 waits after reopening, got ${summary.count}`);
    }
    if (summary.totalSeconds !== 50) {
      throw new Error(
        `expected the wait total to stay 50 seconds, got ${summary.totalSeconds}`,
      );
    }

    const job = getJob("job-reopen");
    if (!job?.started_at || !job.finished_at) {
      throw new Error("the test job has no wall-clock times");
    }
    const wallClockSeconds =
      (Date.parse(job.finished_at) - Date.parse(job.started_at)) / 1000;
    if (wallClockSeconds !== 540) {
      throw new Error(
        `the test job wall clock is ${wallClockSeconds} seconds, want 540`,
      );
    }
    if (Number(summary.totalSeconds) === Number(wallClockSeconds)) {
      throw new Error(
        "the wait total was replaced by the wall-clock duration of the job",
      );
    }
  });
});
