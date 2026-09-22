/** Dashboard browser smoke test (CORE-04).
 *
 *   npm run dashboard:smoke
 *
 * Starts the real `co-maintainer serve` against a throwaway config, repo
 * directory and app.db seeded with one repository, then drives a headless
 * Chromium through every page the router can render. A console error or an
 * uncaught page error fails the run — the dashboard's inline scripts only
 * misbehave in a browser, which no `node:test` can see.
 *
 * The two defects below are known, owned by CORE-70, and recorded rather than
 * ignored: this script keeps proving they exist until CORE-70 removes the
 * marks. Everything else must be clean.
 *
 * CI runs this only on the ubuntu job (`npx playwright install --with-deps
 * chromium`); the Windows test job does not pay for a browser.
 */
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright";
import { openAppDb, closeAppDb } from "../src/store/app_db.ts";
import { writeUserConfig } from "../src/config.ts";
import { activateRepo, markKnowledgeBuilt } from "../src/store/repos.ts";
import { insertReview, setReviewStatus } from "../src/store/reviews.ts";
import { insertFinding } from "../src/store/findings.ts";
import { insertJob, setJobStatus } from "../src/store/jobs.ts";
import { upsertDrift } from "../src/store/drift.ts";
import { recordDelivery } from "../src/store/deliveries.ts";
import {
  commandSpawn,
  makeTempDir,
  mkdir,
  remove,
  setEnv,
  writeTextFile,
} from "../src/util/runtime.ts";
import { runtimeExecPath, runtimeRunArgs } from "../src/testing/runtime.ts";

const PASSWORD = "dashboard-smoke-pass";
const REPO = "acme/widgets";

const PAGES = [
  "/",
  "/setup",
  "/repos/new",
  "/activity",
  "/analytics",
  "/settings",
  "/activity/job-fail",
];

const REPO_PAGES = [
  `/repos/${REPO}`,
  `/repos/${REPO}/pulls`,
  `/repos/${REPO}/pulls/7`,
  `/repos/${REPO}/knowledge`,
  `/repos/${REPO}/settings`,
  `/repos/${REPO}/remote`,
];

type Issue = {
  path: string;
  kind: "console" | "pageerror" | "text";
  text: string;
};

/** The `bindToggle is not defined` crash: `/` and the repo overview run their
 * inline script before `/client.js` has defined the helper. Owned by CORE-70. */
function isKnownBindToggle(issue: Issue): boolean {
  return (
    issue.kind === "pageerror" &&
    issue.text.includes("bindToggle is not defined")
  );
}

/** The settings token list prints this instead of loading, because
 * `loadRemoteTokens()` also runs before `api` exists and falls into its catch.
 * Owned by CORE-70. */
function isKnownTokenList(issue: Issue): boolean {
  return issue.kind === "text" && issue.text.includes("Could not load tokens.");
}

/** A free port for `serve`, so parallel runs and a busy machine never collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kills `serve` and waits for it to actually exit, at most once. `serve`
 * only stops on a signal, so `output()` before a kill would wait forever;
 * this is what makes the error path report instead of hang. The collected
 * output is cached because `output()` is not idempotent: a second call
 * registers fresh listeners on a child that already closed and never
 * settles. */
async function stopServe(): Promise<void> {
  if (!serve || serveStopped) return;
  serveStopped = true;
  serve.kill("SIGTERM");
  serveOutput = await serve.output().catch(() => undefined);
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`serve did not come up at ${url} within ${timeoutMs}ms`);
}

/** Every knob `serve` reads for where it keeps state, pointed at the sandbox
 * so the smoke can never touch the machine's real config or databases. */
function sandboxEnv(sandbox: string): Record<string, string | undefined> {
  return {
    ...process.env,
    CM_CONFIG_PATH: join(sandbox, "config.json"),
    CM_REPOS_DIR: join(sandbox, "repos"),
    CM_APP_DB: join(sandbox, "app.db"),
    CM_CLONES_DIR: join(sandbox, "clones"),
    APPDATA: join(sandbox, "appdata"),
    LOCALAPPDATA: join(sandbox, "localappdata"),
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_DATA_HOME: join(sandbox, "data"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.longpaths",
    GIT_CONFIG_VALUE_0: "true",
  };
}

function seed(): void {
  activateRepo(REPO, 9);
  markKnowledgeBuilt(REPO, "abc");
  upsertDrift({
    repo: REPO,
    as_of: new Date().toISOString(),
    prs_since: 2,
    prs_updated: 1,
    commits_since: 4,
    files_changed: 3,
  });
  // Terminal states only: a queued job would be picked up by serve's worker
  // loop and reach for GitHub and an AI provider.
  insertJob({ id: "job-fail", type: "remake", repo: REPO });
  setJobStatus("job-fail", "failed", {
    error:
      "Error: remake requires a previous init or remake for this repository",
  });
  insertJob({ id: "job-rev", type: "review", repo: REPO, prNumber: 7 });
  setJobStatus("job-rev", "done");
  insertReview({
    id: "rev-old",
    repo: REPO,
    prNumber: 7,
    jobId: "job-old",
    headSha: "oldhead",
    baseSha: "cafebabe",
    scope: "whole-pr",
    model: "fake",
    round: 1,
  });
  setReviewStatus("rev-old", "posted", { findings_count: 1, cost: 0.01 });
  insertFinding({
    id: "f-old",
    reviewId: "rev-old",
    severity: "P1",
    path: "src/legacy.ts",
    lineFrom: 9,
    lineTo: 9,
    title: "old finding",
    bodyMd: "This finding belongs to an earlier review.",
  });
  insertReview({
    id: "rev-1",
    repo: REPO,
    prNumber: 7,
    jobId: "job-rev",
    headSha: "deadbeef",
    baseSha: "cafebabe",
    scope: "whole-pr",
    model: "fake",
    round: 2,
  });
  setReviewStatus("rev-1", "posted", {
    findings_count: 1,
    cost: 0.02,
    tokens_in: 12000,
    tokens_out: 3400,
    duration_ms: 90000,
  });
  insertFinding({
    id: "f-1",
    reviewId: "rev-1",
    severity: "P2",
    path: "src/app.ts",
    lineFrom: 4,
    lineTo: 4,
    title: "unused value",
    bodyMd: "Use the argument or drop it.",
    firstSeenReviewId: "rev-0",
  });
  recordDelivery({
    deliveryId: "d-1",
    event: "pull_request",
    action: "opened",
    repo: REPO,
    prNumber: 8,
    outcome: "skipped",
    reason: "draft",
  });
}

const sandbox = await makeTempDir({ prefix: "cm-dashboard-smoke-" });
const env = sandboxEnv(sandbox);
let serve: ReturnType<typeof commandSpawn> | undefined;
let serveStopped = false;
let serveOutput:
  | Awaited<ReturnType<ReturnType<typeof commandSpawn>["output"]>>
  | undefined;

// The child gets the sandbox env, and this process needs it too for the
// in-process seeding below to land in the same files.
for (const [name, value] of Object.entries(env)) {
  if (value !== undefined) setEnv(name, value);
}

try {
  await mkdir(`${env.CM_REPOS_DIR}/${REPO}`, { recursive: true });
  await writeTextFile(
    `${env.CM_REPOS_DIR}/${REPO}/PR_REVIEW_GUIDE.md`,
    "# guide\nKeep helpers honest.\n",
  );
  await writeUserConfig({ auth: "gh", ai: "none" });
  await openAppDb();
  try {
    seed();
  } finally {
    await closeAppDb();
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  serve = commandSpawn(runtimeExecPath(), {
    args: runtimeRunArgs("main.ts", [
      "serve",
      `--port=${port}`,
      `--password=${PASSWORD}`,
    ]),
    cwd: join(import.meta.dirname, ".."),
    env,
    stdout: "piped",
    stderr: "piped",
  });
  await waitForServer(`${base}/login`, 60_000);
  console.log(`serve up on ${base}`);

  const browser = await chromium.launch();
  const issues: Issue[] = [];
  try {
    const page = await browser.newPage();
    // Derive the path from the live URL instead of a loop variable: the
    // post-login redirect lands on `/` before the loop starts, and a stale
    // label would blame the login page for an error on home.
    const pathOf = (): string => {
      try {
        return new URL(page.url()).pathname;
      } catch {
        return page.url();
      }
    };
    // One listener for the whole run, plus a per-navigation set of failed
    // requests so each page is judged on its own.
    let failedRequests = new Set<string>();
    page.on("console", (message) => {
      if (message.type() === "error") {
        issues.push({ path: pathOf(), kind: "console", text: message.text() });
      }
    });
    page.on("pageerror", (error) => {
      issues.push({
        path: pathOf(),
        kind: "pageerror",
        text: error.message,
      });
    });
    page.on("requestfailed", (request) => {
      failedRequests.add(request.url());
    });

    await page.goto(`${base}/login`, { waitUntil: "load" });
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([
      page.waitForURL(`${base}/`, { timeout: 15_000 }),
      page.click('button[type="submit"]'),
    ]);
    console.log("signed in");

    for (const path of [...PAGES, ...REPO_PAGES]) {
      failedRequests = new Set<string>();
      const response = await page.goto(`${base}${path}`, {
        waitUntil: "load",
      });
      if (response && response.status() !== 200) {
        throw new Error(`${path} returned ${response.status()}`);
      }
      // Inline and deferred page scripts settle a tick after `load`.
      await sleep(400);
      for (const url of failedRequests) {
        issues.push({
          path,
          kind: "console",
          text: `request failed: ${url}`,
        });
      }
      if (path === "/settings") {
        const list =
          (await page.locator("#remote-token-list").textContent()) ?? "";
        if (list.includes("Could not load tokens.")) {
          issues.push({
            path,
            kind: "text",
            text: "Could not load tokens.",
          });
        }
      }
      console.log(`visited ${path}`);
    }
  } finally {
    await browser.close();
  }

  const dedupe = (list: Issue[]): Issue[] => {
    const seen = new Set<string>();
    return list.filter((issue) => {
      const key = `${issue.path}\u0000${issue.kind}\u0000${issue.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const known = dedupe(
    issues.filter(
      (issue) => isKnownBindToggle(issue) || isKnownTokenList(issue),
    ),
  );
  const unexpected = dedupe(
    issues.filter(
      (issue) => !isKnownBindToggle(issue) && !isKnownTokenList(issue),
    ),
  );

  if (known.length > 0) {
    const list = known.map((issue) => `${issue.path}: ${issue.text}`);
    console.log(
      `known defects seen (CORE-70 removes these marks):\n  ${list.join("\n  ")}`,
    );
  }

  if (unexpected.length > 0) {
    const list = unexpected.map(
      (issue) => `  ${issue.path} [${issue.kind}] ${issue.text}`,
    );
    throw new Error(`dashboard issues:\n${list.join("\n")}`);
  }

  console.log("dashboard smoke ok");
} catch (error) {
  await stopServe();
  if (serveOutput) {
    // `stopServe` already awaited the child and cached the buffers.
    const stdout = new TextDecoder().decode(serveOutput.stdout);
    const stderr = new TextDecoder().decode(serveOutput.stderr);
    console.error(`--- serve stdout ---\n${stdout}`);
    console.error(`--- serve stderr ---\n${stderr}`);
  }
  throw error;
} finally {
  await stopServe();
  await remove(sandbox, { recursive: true }).catch(() => {});
}
