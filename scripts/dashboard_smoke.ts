/** Dashboard browser smoke test.
 *
 *   npm run dashboard:smoke
 *
 * Starts the real `co-maintainer serve` against a throwaway config, repo
 * directory and app.db seeded with one repository, then drives a headless
 * Chromium through every page the router can render. A console error or an
 * uncaught page error fails the run — the dashboard's inline scripts only
 * misbehave in a browser, which no `node:test` can see.
 *
 * The `bindToggle` and `loadRemoteTokens` crashes that once hit these pages are gone
 * from the marks below: the helper is inlined into `<head>` ahead of every
 * page script, and the token list waits for `DOMContentLoaded`. Everything
 * here must be clean now.
 *
 * `SMOKE_SHOTS=<dir>` also saves a screenshot of the review policy editor,
 * so a change to it can be looked at, not only asserted.
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
import { KNOWN_COST } from "../src/testing/fixtures/cost.ts";
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
  stat,
  writeTextFile,
} from "../src/util/runtime.ts";
import { cacheGet, cacheSet } from "../src/store/cache_db.ts";
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

async function seed(): Promise<void> {
  activateRepo(REPO, 9);
  markKnowledgeBuilt(REPO, "abc");
  await cacheSet("state", REPO, "{}");
  await cacheSet("cost", `${REPO}:smoke`, "{}");
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
  setReviewStatus("rev-old", "posted", {
    findings_count: 1,
    ...KNOWN_COST(0.01),
  });
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
    ...KNOWN_COST(0.02),
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
  // A real free model: cost is known and genuinely $0, unlike the two rounds
  // below whose cost never got recorded. Both must stay visually distinct:
  // "$0.00" here, "unknown" there, never the other way round.
  insertReview({
    id: "rev-free",
    repo: REPO,
    prNumber: 7,
    jobId: "job-free",
    headSha: "f0f0f0f",
    baseSha: "cafebabe",
    scope: "whole-pr",
    model: "fake",
    round: 3,
  });
  setReviewStatus("rev-free", "posted", {
    findings_count: 0,
    ...KNOWN_COST(0),
  });
  insertReview({
    id: "rev-unknown",
    repo: REPO,
    prNumber: 7,
    jobId: "job-unknown",
    headSha: "abcabc1",
    baseSha: "cafebabe",
    scope: "whole-pr",
    model: "fake",
    round: 4,
  });
  setReviewStatus("rev-unknown", "posted", {
    findings_count: 0,
    cost_status: "unknown",
    cost_note: "provider_did_not_report",
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
  recordDelivery({
    deliveryId: "d-2",
    event: "pull_request",
    action: "opened",
    repo: REPO,
    prNumber: 9,
    outcome: "skipped",
    reason: "Rule 3 (trusted author): waiting for a maintainer request.",
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
    await seed();
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
      if (path === "/settings") {
        const boxes = await page
          .locator('input[type="checkbox"]')
          .evaluateAll((inputs) =>
            inputs.map((input) => {
              const box = input.getBoundingClientRect();
              const label = input.closest("label");
              const range = document.createRange();
              range.selectNodeContents(label ?? input);
              const line = range.getBoundingClientRect();
              const middle = box.top + box.height / 2;
              return {
                id: input.id,
                width: box.width,
                sameLine: middle >= line.top && middle <= line.bottom,
                textOnBoxLine: label !== null && line.height < box.height * 2.5,
              };
            }),
          );
        if (boxes.length === 0) {
          issues.push({ path, kind: "text", text: "no checkbox found" });
        }
        for (const box of boxes) {
          if (box.width >= 32 || !box.sameLine || !box.textOnBoxLine) {
            issues.push({
              path,
              kind: "text",
              text: `checkbox #${box.id} is ${Math.round(box.width)}px wide or off its label line`,
            });
          }
        }
      }
      // The seeded PR carries a real $0.00 review and an unknown-cost one:
      // the page must show both, and never turn the unknown one
      // into the same $0.00 as the free one.
      if (
        [
          "/activity",
          "/analytics",
          `/repos/${REPO}`,
          `/repos/${REPO}/pulls`,
          `/repos/${REPO}/pulls/7`,
        ].includes(path)
      ) {
        const body = await page.locator("body").innerText();
        if (!body.includes("unknown")) {
          issues.push({
            path,
            kind: "text",
            text: "an unknown-cost review is missing its unknown label",
          });
        }
      }
      if (path === `/repos/${REPO}/pulls/7`) {
        const body = await page.locator("body").innerText();
        if (!body.includes("$0.00")) {
          issues.push({
            path,
            kind: "text",
            text: "the free review's real $0.00 did not render",
          });
        }
      }
      console.log(`visited ${path}`);
    }

    // The review policy editor, driven the way a maintainer would.
    const shot = async (name: string): Promise<void> => {
      const dir = process.env.SMOKE_SHOTS;
      if (dir)
        await page.screenshot({
          path: join(dir, `${name}.png`),
          fullPage: true,
        });
    };
    const controlIssues = async (scope: string): Promise<string[]> =>
      await page.locator(scope).evaluate((root) => {
        const problems: string[] = [];
        for (const control of root.querySelectorAll("input, select")) {
          const id = control.id;
          const named =
            control.closest("label") !== null ||
            (id !== "" && root.querySelector(`label[for="${id}"]`) !== null);
          if (!named) problems.push(`#${id || "(no id)"} has no label`);
          if (control.getAttribute("type") === "checkbox") {
            const width = control.getBoundingClientRect().width;
            if (width >= 32)
              problems.push(`checkbox #${id} is ${Math.round(width)}px wide`);
          }
        }
        return problems;
      });
    const summaryHas = async (text: string): Promise<void> => {
      await page.waitForFunction(
        (wanted) =>
          document
            .querySelector("#policy-summary")
            ?.textContent?.includes(wanted),
        text,
        { timeout: 5000 },
      );
    };

    await page.goto(`${base}/repos/${REPO}/settings`, { waitUntil: "load" });
    if ((await page.locator("#policy-template").inputValue()) !== "legacy") {
      throw new Error(
        "a repository nobody gave a policy must show the simple switches",
      );
    }
    if ((await page.locator("#auto").count()) !== 1) {
      throw new Error(
        "the switches must be shown while the repository follows them",
      );
    }
    await shot("policy-legacy");

    await page.selectOption("#policy-template", "trusted-auto");
    await summaryHas("waits for a maintainer request");
    await page.click("#policy-details summary");
    await page.click("#add-rule");
    await page.fill("#r3-name", "newcomers");
    await page.check("#r3-a-FIRST_TIME_CONTRIBUTOR");
    await page.selectOption("#r3-action", "skip");
    await summaryHas("first time contributors are not reviewed");
    if ((await page.locator("#policy-template").inputValue()) !== "custom") {
      throw new Error(
        "editing a rule must turn the template into custom rules",
      );
    }
    const editorIssues = await controlIssues("#policy-card");
    for (const problem of editorIssues) {
      issues.push({
        path: `/repos/${REPO}/settings`,
        kind: "text",
        text: problem,
      });
    }
    await shot("policy-custom");

    const issuesBefore = issues.length;
    await page.fill("#p-max", "0");
    await page.waitForSelector("#policy-problem:not([hidden])", {
      timeout: 5000,
    });
    if (!(await page.locator("#save-policy").isDisabled())) {
      throw new Error("a policy the server refuses must not be saveable");
    }
    // The refusal is a 422 on purpose, and the browser logs it as a console
    // error. That one line is expected here and nowhere else.
    for (let i = issues.length - 1; i >= issuesBefore; i--) {
      if (issues[i]!.kind === "console" && issues[i]!.text.includes("422")) {
        issues.splice(i, 1);
      }
    }
    await page.fill("#p-max", "");
    await page.waitForFunction(
      () => !document.querySelector("#save-policy")?.hasAttribute("disabled"),
      null,
      { timeout: 5000 },
    );

    await Promise.all([page.waitForEvent("load"), page.click("#save-policy")]);
    await sleep(400);
    if ((await page.locator("#policy-template").inputValue()) !== "custom") {
      throw new Error("the saved custom policy did not come back as custom");
    }
    if ((await page.locator("#auto").count()) !== 0) {
      throw new Error("the switches must be gone once a policy decides");
    }
    if ((await page.locator("#r3-name").inputValue()) !== "newcomers") {
      throw new Error("the saved rule did not come back");
    }

    await page.selectOption("#policy-template", "legacy");
    await Promise.all([page.waitForEvent("load"), page.click("#save-policy")]);
    await sleep(400);
    if ((await page.locator("#auto").count()) !== 1) {
      throw new Error("going back to the simple switches must show them again");
    }
    console.log("review policy editor works");

    await page.goto(`${base}/settings`, { waitUntil: "load" });
    await page.selectOption("#def-policy", "trusted-auto");
    const described =
      (await page.locator("#def-policy-desc").textContent()) ?? "";
    if (!described.includes("Owners, members and collaborators")) {
      throw new Error(
        `the default policy description did not update: ${described}`,
      );
    }
    await Promise.all([page.waitForEvent("load"), page.click("#save-def")]);
    await sleep(400);
    if ((await page.locator("#def-policy").inputValue()) !== "trusted-auto") {
      throw new Error("the server default policy did not stick");
    }
    console.log("server default policy works");

    await page.goto(`${base}/repos/new`, { waitUntil: "load" });
    await page.evaluate(() => {
      // The plan step normally comes from a GitHub preview, which this
      // sandbox cannot reach, so the page is handed a plan directly.
      (window as unknown as { showPlan: (plan: unknown) => void }).showPlan({
        repo: "acme/other",
        command: "co-maintainer init acme/other",
        patch: {},
        reasons: [],
        estimate: {
          extract: 1,
          synth: 1,
          tokensIn: [1, 2],
          tokensOut: [1, 2],
          seconds: [1, 2],
          usd: null,
          estimateBasis: "history",
        },
      });
    });
    const radios = await page.locator('input[name="policy"]').count();
    if (radios !== 3)
      throw new Error(`expected 3 policy choices, found ${radios}`);
    if (!(await page.locator("#policy-trusted-auto").isChecked())) {
      throw new Error(
        "the server default must be pre-selected when adding a repository",
      );
    }
    for (const problem of await controlIssues("#plan")) {
      issues.push({ path: "/repos/new", kind: "text", text: problem });
    }
    console.log("add repository policy choice works");

    await page.goto(`${base}/activity`, { waitUntil: "load" });
    const reviewNow = page.locator("[data-post$='/pulls/9/review']");
    if ((await reviewNow.count()) !== 1) {
      throw new Error(
        "a pull request waiting for a request needs a Review now button",
      );
    }
    if ((await page.locator("[data-post$='/pulls/8/review']").count()) !== 0) {
      throw new Error("a skipped draft must not offer Review now");
    }
    if (!((await reviewNow.getAttribute("aria-label")) ?? "").includes("#9")) {
      throw new Error("the Review now button must name its pull request");
    }
    console.log("review now button shown");

    // The token secret panel only exists after a real create, so drive the
    // button the same way an operator would and assert the panel appears.
    await page.goto(`${base}/settings`, { waitUntil: "load" });
    const tokenName = `smoke-${Date.now()}`;
    await page.fill("#remote-token-name", tokenName);
    await page.click("#create-remote-token");
    await page.waitForSelector("#remote-token-secret:not([hidden])", {
      timeout: 10_000,
    });
    const secret =
      (await page.locator("#remote-token-secret").textContent()) ?? "";
    if (!secret.includes("cmr_")) {
      throw new Error("the secret panel did not show a token");
    }
    if (!secret.includes("is not shown again")) {
      throw new Error("the secret panel is missing its warning");
    }
    console.log("token secret panel shown");

    // Clear knowledge with the cached-evidence checkbox, the way an operator
    // would. The page asks for a confirmation first.
    await page.goto(`${base}/repos/${REPO}/knowledge`, { waitUntil: "load" });
    let sawConfirm = false;
    page.once("dialog", (dialog) => {
      sawConfirm = true;
      void dialog.accept();
    });
    await page.check("#clear-cache");
    await Promise.all([page.waitForEvent("load"), page.click("#clear")]);
    if (!sawConfirm) throw new Error("the clear did not ask for confirmation");
    await sleep(400);
    const notice = (await page.locator(".notice").first().textContent()) ?? "";
    if (!notice.includes("Knowledge has not been built yet")) {
      throw new Error(`the clear did not reset the notice: ${notice}`);
    }
    let guideSurvived = true;
    try {
      await stat(join(env.CM_REPOS_DIR ?? "", REPO, "PR_REVIEW_GUIDE.md"));
    } catch {
      guideSurvived = false;
    }
    if (guideSurvived) throw new Error("the guide file survived the clear");
    if ((await cacheGet("state", REPO)) !== undefined) {
      throw new Error("the skill state survived the clear");
    }
    if ((await cacheGet("cost", `${REPO}:smoke`)) !== undefined) {
      throw new Error("the cached evidence survived includeCache");
    }
    console.log("clear knowledge works");
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
  const unexpected = dedupe(issues);

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
