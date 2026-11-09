/** Commit watch smoke test.
 *
 *   node scripts/commit_watch_smoke.ts
 *
 * Real git (a bare remote and a working clone), the real `serve`, the real
 * CLI (`review --remote --range`), and a fake AI and a fake GitHub. Nothing
 * reaches GitHub or an AI provider and nothing costs money. Each scenario of
 * `dev-work/commit-watch/index.html` is checked against what ended up where a
 * user would see it: the issues and comments on GitHub, the check runs, the
 * CI step's output and exit code, and the dashboard.
 *
 * The fake AI answers each job from a file in `CM_FAKE_AI_DIR`, so a scenario
 * sets the review it wants before it pushes. */
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startFakeGithub,
  type FakeGithub,
} from "../src/testing/fake_github.ts";
import { TEST_PKCS1_PEM } from "../src/testing/fixtures/rsa_key.ts";

const ROOT = join(import.meta.dirname, "..");
const REPO = "acme/widgets";
const FRESH = "acme/fresh";
const SECRET = "commit-watch-smoke-secret";
const PASSWORD = "commit-watch-smoke-pass";
const TOKEN = "cmr_commit_watch_smoke_token_0123456789abcdef";

const sandbox = join(tmpdir(), `cm-commit-watch-${process.pid}-${Date.now()}`);
const bare = join(sandbox, "remote.git");
const work = join(sandbox, "work");
const aiDir = join(sandbox, "ai");
mkdirSync(aiDir, { recursive: true });

const env: Record<string, string | undefined> = {
  ...process.env,
  CM_CONFIG_PATH: join(sandbox, "config.json"),
  CM_REPOS_DIR: join(sandbox, "repos"),
  CM_APP_DB: join(sandbox, "app.db"),
  CM_CLONES_DIR: join(sandbox, "clones"),
  XDG_CONFIG_HOME: join(sandbox, "xdg-config"),
  XDG_CACHE_HOME: join(sandbox, "xdg-cache"),
  XDG_DATA_HOME: join(sandbox, "xdg-data"),
  CM_FAKE_AI: "1",
  CM_FAKE_AI_DIR: aiDir,
  GIT_AUTHOR_NAME: "smoke",
  GIT_AUTHOR_EMAIL: "smoke@example.com",
  GIT_COMMITTER_NAME: "smoke",
  GIT_COMMITTER_EMAIL: "smoke@example.com",
};
// The seed below runs in this process against the same files.
for (const key of [
  "CM_CONFIG_PATH",
  "CM_REPOS_DIR",
  "CM_APP_DB",
  "CM_CLONES_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
]) {
  process.env[key] = env[key];
}

const failures: string[] = [];
let current = "";

function check(ok: unknown, message: string): void {
  if (!ok) failures.push(`${current}: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

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

async function waitFor<T>(
  what: string,
  read: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

// --- the fake AI ----------------------------------------------------------

function setAi(job: string, text: string): void {
  writeFileSync(join(aiDir, `${job}.txt`), text);
}

function setDelay(ms: number): void {
  writeFileSync(join(aiDir, "delay_ms"), String(ms));
}

function aiRequests(): { job: string; system: string; prompt: string }[] {
  try {
    return readFileSync(join(aiDir, "requests.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function finding(
  severity: string,
  path: string,
  from: number,
  to: number,
  title: string,
): string {
  const impact =
    severity === "P0" || severity === "P1" ? "blocking" : "non-blocking";
  return `### [${severity} · ${impact}] \`${path}\`: \`${title}\`
Location: \`${path}:${from}-${to}\`

${title} is wrong here.

It breaks the invariant the guide describes.
`;
}

function review(findings: string[], verdicts: string[] = []): string {
  const body = findings.length
    ? findings.join("\n")
    : "No actionable findings.\n";
  const previous = verdicts.length
    ? `\n## Previous findings\n\n${verdicts.join("\n")}\n`
    : "";
  return `## Findings\n\n${body}${previous}`;
}

// --- git ------------------------------------------------------------------

function writeFile(path: string, content: string): void {
  const full = join(work, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** Commits and pushes to main. Returns the push's before and after. */
function push(
  files: Record<string, string>,
  message: string,
): { before: string; after: string } {
  const before = git(work, ["rev-parse", "HEAD"]);
  for (const [path, content] of Object.entries(files)) writeFile(path, content);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", message]);
  git(work, ["push", "-q", "origin", "HEAD:main"]);
  return { before, after: git(work, ["rev-parse", "HEAD"]) };
}

// --- serve, webhooks, CI ----------------------------------------------------

let base = "";
let serveProc: ReturnType<typeof spawn> | undefined;
let serveLog = "";
let github!: FakeGithub;
let delivery = 0;

async function webhook(
  event: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  const response = await fetch(`${base}/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `smoke-${++delivery}`,
      "x-hub-signature-256": signature,
    },
    body,
  });
  return (await response.json()) as Record<string, unknown>;
}

function pushPayload(
  repo: string,
  before: string,
  after: string,
  ref = "refs/heads/main",
) {
  return {
    ref,
    before,
    after,
    deleted: false,
    repository: { full_name: repo, default_branch: "main" },
    installation: { id: 1 },
  };
}

function commentPayload(issue: number, body: string, association = "OWNER") {
  return {
    action: "created",
    issue: { number: issue },
    comment: {
      id: 50_000 + delivery,
      body,
      author_association: association,
      user: { login: "maintainer", type: "User" },
    },
    repository: { full_name: REPO },
    installation: { id: 1 },
  };
}

type Run = { code: number | null; stdout: string; stderr: string };

function ci(
  before: string,
  after: string,
  extra: {
    host?: string;
    token?: string;
    repo?: string;
    timeout?: string;
  } = {},
): Promise<Run> {
  const args = [
    join(ROOT, "main.ts"),
    "review",
    "--remote",
    `--range=${before}..${after}`,
    `--repo=${extra.repo ?? REPO}`,
    "--branch=main",
    "--output=github",
    ...(extra.timeout ? [`--timeout-minutes=${extra.timeout}`] : []),
  ];
  return new Promise((resolve) => {
    // The CLI runs in the clone, the way a CI step does.
    const child = spawn(process.execPath, args, {
      cwd: work,
      env: {
        ...env,
        CM_REMOTE_HOST: extra.host ?? base,
        CM_REMOTE_TOKEN: extra.token ?? TOKEN,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let cookie = "";
async function login(): Promise<void> {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(PASSWORD)}`,
    redirect: "manual",
  });
  cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  if (!cookie) throw new Error("login did not set a cookie");
}

async function page(path: string): Promise<string> {
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
  if (response.status !== 200)
    throw new Error(`${path} answered ${response.status}`);
  return await response.text();
}

async function patchRepo(
  repo: string,
  body: Record<string, unknown>,
): Promise<number> {
  const response = await fetch(`${base}/api/repos/${repo}`, {
    method: "PATCH",
    headers: {
      cookie,
      "content-type": "application/json",
      "x-requested-with": "co-maintainer",
    },
    body: JSON.stringify(body),
  });
  return response.status;
}

// --- reading the server's database -----------------------------------------

async function db<T>(
  sql: string,
  ...params: (string | number)[]
): Promise<T[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const handle = new DatabaseSync(env.CM_APP_DB!, { readOnly: true });
  try {
    return handle.prepare(sql).all(...params) as T[];
  } finally {
    handle.close();
  }
}

async function pushReview(after: string) {
  const rows = await db<{
    id: string;
    status: string;
    base_sha: string;
    job_id: string;
  }>(
    `SELECT r.id, r.status, r.base_sha, r.job_id FROM reviews r
     JOIN push_events p ON p.review_id = r.id
     WHERE r.kind = 'push' AND p.after_sha = ?`,
    after,
  );
  return rows[0];
}

async function reviewDone(after: string) {
  return await waitFor(`the review of ${after.slice(0, 7)}`, async () => {
    const row = await pushReview(after);
    return row && (row.status === "done" || row.status === "failed")
      ? row
      : undefined;
  });
}

function issue(number: number) {
  return github.state.issues.find((i) => i.number === number);
}

// --- setup -------------------------------------------------------------------

const REFUND_BUG = `export function refund(amount: number) {
  const total = amount * 2;
  return total;
}
`;
// Rewrites the finding's own line, still doubling.
const REFUND_STILL_BAD = `export function refund(amount: number) {
  const total = 2 * amount;
  return total;
}
`;
const RETRY_BUG = `export async function retry(fn: () => Promise<void>) {
  while (true) await fn();
}
`;

async function setup(): Promise<void> {
  mkdirSync(sandbox, { recursive: true });
  git(sandbox, ["init", "-q", "--bare", "-b", "main", bare]);
  git(sandbox, ["clone", "-q", bare, work]);
  git(work, ["checkout", "-q", "-b", "main"]);
  writeFile("README.md", "# widgets\n");
  writeFile(
    "src/billing/refund.ts",
    "export function refund(amount: number) {\n  return amount;\n}\n",
  );
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "initial"]);
  git(work, ["push", "-q", "origin", "main"]);

  github = await startFakeGithub({
    repos: [REPO, FRESH],
    bare,
    // Commit watch through the App is off until scenario 21 is checked.
    events: ["pull_request", "issue_comment"],
  });

  const { writeUserConfig } = await import("../src/config.ts");
  await writeUserConfig({
    githubAppId: "1",
    githubAppPrivateKey: TEST_PKCS1_PEM,
    githubWebhookSecret: SECRET,
    ai: "openrouter",
    lowModel: "fake/low",
    highModel: "fake/high",
  } as never);
  const guideDir = join(env.CM_REPOS_DIR!, REPO);
  mkdirSync(guideDir, { recursive: true });
  writeFileSync(
    join(guideDir, "PR_REVIEW_GUIDE.md"),
    "# Review guide\n\n- Refunds never double the amount.\n",
  );

  const { openAppDb, closeAppDb } = await import("../src/store/app_db.ts");
  const { activateRepo, markKnowledgeBuilt } =
    await import("../src/store/repos.ts");
  const { insertRemoteToken } = await import("../src/store/remote_tokens.ts");
  const { hashRemoteBearerToken } =
    await import("../src/services/remote_tokens.ts");
  await openAppDb();
  try {
    activateRepo(REPO, 1);
    markKnowledgeBuilt(REPO, "seed");
    activateRepo(FRESH, 1);
    insertRemoteToken("token-1", "ci", await hashRemoteBearerToken(TOKEN));
  } finally {
    await closeAppDb();
  }

  base = `http://127.0.0.1:${await freePort()}`;
  await startServe();
}

async function startServe(): Promise<void> {
  const port = new URL(base).port;
  serveProc = spawn(
    process.execPath,
    ["main.ts", "serve", `--port=${port}`, `--password=${PASSWORD}`],
    {
      cwd: ROOT,
      env: { ...env, CM_GITHUB_API_URL: github.url },
    },
  );
  serveProc.stdout?.on("data", (chunk) => (serveLog += chunk));
  serveProc.stderr?.on("data", (chunk) => (serveLog += chunk));
  await waitFor(
    "serve",
    async () => {
      try {
        const response = await fetch(`${base}/login`);
        return response.status < 500;
      } catch {
        return false;
      }
    },
    60_000,
  );
  await login();
}

/** `serve` holds app.db's lock, so a step that opens it here stops `serve`
 * first and starts it again after. */
async function withServeStopped(run: () => Promise<void>): Promise<void> {
  const proc = serveProc;
  if (proc && proc.exitCode === null) {
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    proc.kill("SIGTERM");
    await exited;
  }
  try {
    await run();
  } finally {
    await startServe();
  }
}

/** A direct write to the server's database, for a change no API makes. */
async function dbWrite(
  sql: string,
  ...params: (string | number | null)[]
): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const handle = new DatabaseSync(env.CM_APP_DB!);
  try {
    handle.exec("PRAGMA busy_timeout = 5000");
    handle.prepare(sql).run(...params);
  } finally {
    handle.close();
  }
}

// --- scenarios ---------------------------------------------------------------

async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  current = name;
  const before = failures.length;
  try {
    await run();
  } catch (error) {
    failures.push(
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.log(`${failures.length === before ? "ok  " : "FAIL"} ${name}`);
}

async function main(): Promise<void> {
  await setup();

  await scenario("21 push event off, no CI: the card says off", async () => {
    const html = await page(`/repos/${REPO}`);
    check(html.includes("Commit watch"), "no Commit watch card");
    check(
      html.includes("the Push event is off"),
      "the card does not say the Push event is off",
    );
    check(
      /remote-host: http:\/\/(127\.0\.0\.1|localhost):\d+/.test(html),
      "the CI workflow does not carry this server's address",
    );
    github.state.events.push("push");
  });

  let refund = { before: "", after: "" };
  await scenario("1 a P1 finding opens an issue (App)", async () => {
    setAi(
      "review_push",
      review([
        finding(
          "P1",
          "src/billing/refund.ts",
          2,
          2,
          "refund doubles the amount",
        ),
      ]),
    );
    refund = push({ "src/billing/refund.ts": REFUND_BUG }, "refund: double it");
    const result = await webhook(
      "push",
      pushPayload(REPO, refund.before, refund.after),
    );
    check(
      result.outcome === "enqueued",
      `webhook outcome ${String(result.outcome)}`,
    );
    const row = await reviewDone(refund.after);
    check(row.status === "done", `review ${row.status}`);
    const opened = issue(1);
    check(opened, "no issue opened");
    check(
      opened?.title === "[P1] refund doubles the amount is wrong here.",
      `title ${opened?.title}`,
    );
    check(
      opened?.labels.includes("co-maintainer") &&
        opened.labels.includes("cm-P1"),
      "labels",
    );
    check(
      opened?.body.includes(`/blob/${refund.after}/src/billing/refund.ts#L2`),
      "Where permalink",
    );
    check(
      opened?.body.includes(
        `\`${refund.before.slice(0, 7)}..${refund.after.slice(0, 7)}\` on \`main\``,
      ),
      "Push range",
    );
    check(
      opened?.body.includes(
        "Feel free to ask questions here if you need more detail.",
      ),
      "questions line",
    );
    check(
      opened?.body.includes("Opened by co-maintainer commit watch review."),
      "footer",
    );
    check(
      /<!-- co-maintainer:finding [0-9a-f-]+ -->/.test(opened?.body ?? ""),
      "hidden marker",
    );
    check(!opened?.body.includes("/repos/"), "a dashboard link in the issue");
    const run = github.state.checkRuns.find((r) => r.head_sha === refund.after);
    check(run?.conclusion === "success", `check run ${run?.conclusion}`);
    check(
      (run?.output?.annotations ?? []).length === 1,
      "check run annotation",
    );
  });

  await scenario("2 changed lines: change in, still found", async () => {
    setAi("review_push", review([], ["- F1: open src/billing/refund.ts:2-2"]));
    const next = push(
      { "src/billing/refund.ts": REFUND_STILL_BAD },
      "refund: reorder",
    );
    await webhook("push", pushPayload(REPO, next.before, next.after));
    await reviewDone(next.after);
    const last = issue(1)?.comments.at(-1)?.body ?? "";
    const range = `${next.before.slice(0, 7)}..${next.after.slice(0, 7)}`;
    check(
      last ===
        `change in ${next.after.slice(0, 7)}: changed, still found by the review of ${range}`,
      `comment was: ${last}`,
    );
    check(!last.includes("latest review"), "says latest review");
    check(issue(1)?.state === "open", "the issue closed");
    const request = aiRequests()
      .filter((r) => r.job === "review_push")
      .at(-1);
    check(
      request?.prompt.includes("known issue #1"),
      "the review was not told about issue #1",
    );
  });

  await scenario("3 closed by a maintainer but not fixed (A)", async () => {
    github.closeAsUser(1);
    setAi("review_push", review([], ["- F1: open"]));
    const next = push({ "README.md": "# widgets\n\nDocs.\n" }, "docs");
    await webhook("push", pushPayload(REPO, next.before, next.after));
    await reviewDone(next.after);
    const range = `${next.before.slice(0, 7)}..${next.after.slice(0, 7)}`;
    const last = issue(1)?.comments.at(-1)?.body ?? "";
    check(
      last ===
        `This issue was closed, but the review of push ${range} still finds the problem. If there is something I should know, please leave it as a comment.`,
      `comment was: ${last}`,
    );
    check(issue(1)?.state === "closed", "the issue was reopened");
    const count = issue(1)?.comments.length ?? 0;
    const again = push(
      { "README.md": "# widgets\n\nMore docs.\n" },
      "docs again",
    );
    await webhook("push", pushPayload(REPO, again.before, again.after));
    await reviewDone(again.after);
    check(
      issue(1)?.comments.length === count,
      "commented twice for one closing",
    );
  });

  let retryIssue = 0;
  await scenario("4 fixed by a push, then back again (B)", async () => {
    setAi(
      "review_push",
      review([finding("P1", "src/net/retry.ts", 2, 2, "retry never stops")]),
    );
    const add = push({ "src/net/retry.ts": RETRY_BUG }, "retry");
    await webhook("push", pushPayload(REPO, add.before, add.after));
    await reviewDone(add.after);
    retryIssue = github.state.issues.length;
    check(
      issue(retryIssue)?.title === "[P1] retry never stops is wrong here.",
      "no retry issue",
    );
    setAi("review_push", review([], ["- F1: closed"]));
    const fix = push(
      {
        "src/net/retry.ts":
          "export async function retry(fn: () => Promise<void>) {\n  await fn();\n}\n",
      },
      "retry: once",
    );
    await webhook("push", pushPayload(REPO, fix.before, fix.after));
    await reviewDone(fix.after);
    const range = `${fix.before.slice(0, 7)}..${fix.after.slice(0, 7)}`;
    check(
      issue(retryIssue)?.comments.at(-1)?.body ===
        `change in ${fix.after.slice(0, 7)}: changed, no longer found by the review of ${range}. Closing.`,
      `fixed comment: ${issue(retryIssue)?.comments.at(-1)?.body}`,
    );
    check(
      issue(retryIssue)?.state === "closed" &&
        issue(retryIssue)?.closedBy === "bot",
      "co-maintainer did not close it",
    );
    setAi(
      "review_push",
      review([finding("P1", "src/net/retry.ts", 2, 2, "retry never stops")]),
    );
    const back = push({ "src/net/retry.ts": RETRY_BUG }, "retry: loop again");
    await webhook("push", pushPayload(REPO, back.before, back.after));
    await reviewDone(back.after);
    check(
      github.state.issues.length === retryIssue + 1,
      "no new issue when the problem came back",
    );
  });

  await scenario(
    "5 ignore reply, then the next sync drops the finding",
    async () => {
      const target = github.state.issues.length;
      setAi("watch_comment_classify", '{"forUs": true, "kind": "ignore"}');
      const result = await webhook(
        "issue_comment",
        commentPayload(
          target,
          "@co-maintainer this loop is intended, ignore it",
        ),
      );
      check(result.outcome === "enqueued", `webhook ${String(result.outcome)}`);
      await waitFor("the noted reply", () =>
        issue(target)?.comments.some((c) =>
          c.body.startsWith(
            "Noted, I will take this into account on the next sync.",
          ),
        ),
      );
      const notes = await db<{ kind: string }>(
        `SELECT kind FROM watch_notes WHERE issue_number = ?`,
        target,
      );
      check(notes[0]?.kind === "ignore", "no ignore note stored");
      // What `sync` does with the notes, on the server's own database, between
      // two pushes.
      setAi(
        "watch_note",
        "Retry loops in src/net are intended and must not be reported.",
      );
      const { openAppDb, closeAppDb } = await import("../src/store/app_db.ts");
      const { applyWatchNotes, withMaintainerNotes } =
        await import("../src/services/watch_notes.ts");
      const { FakeAiProvider } = await import("../src/ai/fake.ts");
      process.env.CM_FAKE_AI_DIR = aiDir;
      let lines: string[] = [];
      await withServeStopped(async () => {
        await openAppDb();
        try {
          lines = await applyWatchNotes(REPO, new FakeAiProvider());
        } finally {
          await closeAppDb();
        }
      });
      check(
        withMaintainerNotes("# Guide\n", lines).includes(
          "Retry loops in src/net are intended",
        ),
        "the note is not in the guide",
      );
      const state = await db<{ state: string }>(
        `SELECT state FROM watch_issues WHERE issue_number = ?`,
        target,
      );
      check(state[0]?.state === "ignored", `issue state ${state[0]?.state}`);
      setAi(
        "review_push",
        review([finding("P1", "src/net/retry.ts", 2, 2, "retry never stops")]),
      );
      const count = github.state.issues.length;
      const next = push(
        {
          "src/net/retry.ts": RETRY_BUG.replace("fn: ()", "fn:  ()"),
          "README.md": "# widgets\n\nIgnored.\n",
        },
        "touch retry",
      );
      const run = await ci(next.before, next.after);
      check(run.code === 0, `CI exit ${run.code}`);
      check(
        !run.stdout.includes("retry never stops"),
        "the ignored finding was reported to CI",
      );
      check(
        github.state.issues.length === count,
        "an issue was opened for an ignored finding",
      );
    },
  );

  await scenario("6 a question in English gets an answer", async () => {
    setAi("watch_comment_classify", '{"forUs": true, "kind": "question"}');
    setAi(
      "watch_comment_answer",
      "Doubling the amount pays the customer twice.",
    );
    await webhook(
      "issue_comment",
      commentPayload(1, "@co-maintainer why is this a problem?"),
    );
    await waitFor("the answer", () =>
      issue(1)?.comments.some((c) =>
        c.body.startsWith("Doubling the amount pays the customer twice."),
      ),
    );
  });

  await scenario(
    "7 a question in Portuguese is answered in its language",
    async () => {
      setAi(
        "watch_comment_answer",
        "Dobrar o valor paga o cliente duas vezes.",
      );
      await webhook(
        "issue_comment",
        commentPayload(1, "@co-maintainer por que isso é um problema?"),
      );
      await waitFor("the answer", () =>
        issue(1)?.comments.some((c) => c.body.startsWith("Dobrar o valor")),
      );
      const request = aiRequests()
        .filter((r) => r.job === "watch_comment_answer")
        .at(-1);
      check(
        request?.system.includes("same language as the question"),
        "the answer is not asked in the question's language",
      );
      check(
        request?.prompt.includes("por que isso é um problema?"),
        "the question did not reach the answer",
      );
    },
  );

  await scenario("8 a comment for someone else gets no reply", async () => {
    setAi("watch_comment_classify", '{"forUs": false, "kind": "other"}');
    const count = issue(1)?.comments.length ?? 0;
    const result = await webhook(
      "issue_comment",
      commentPayload(1, "@asd can you take a look"),
    );
    await waitFor("the job", async () => {
      const rows = await db<{ status: string }>(
        `SELECT status FROM jobs WHERE id = ?`,
        String(result.jobId),
      );
      return (
        rows[0] && rows[0].status !== "queued" && rows[0].status !== "running"
      );
    });
    check(
      issue(1)?.comments.length === count,
      "replied to a comment meant for someone else",
    );
  });

  await scenario("9 no write access: not listened to", async () => {
    const result = await webhook(
      "issue_comment",
      commentPayload(1, "@co-maintainer ignore this", "NONE"),
    );
    check(result.outcome === "skipped", `outcome ${String(result.outcome)}`);
    check(
      String(result.reason).startsWith("no-write-access"),
      `reason ${String(result.reason)}`,
    );
  });

  await scenario(
    "10 force-push keeps open issues and reviews the new range",
    async () => {
      setAi(
        "review_push",
        review([finding("P1", "src/auth/token.ts", 1, 1, "token is logged")]),
      );
      const add = push(
        { "src/auth/token.ts": "console.log(process.env.TOKEN);\n" },
        "token",
      );
      await webhook("push", pushPayload(REPO, add.before, add.after));
      await reviewDone(add.after);
      const tokenIssue = github.state.issues.length;
      check(
        issue(tokenIssue)?.title.startsWith("[P1] token is logged"),
        "no issue to keep",
      );
      const comments = issue(tokenIssue)?.comments.length ?? 0;
      // The commit with the finding is rewritten away.
      const before = git(work, ["rev-parse", "HEAD"]);
      git(work, ["reset", "-q", "--hard", "HEAD~1"]);
      writeFile("src/billing/notes.ts", "export const NOTE = 1;\n");
      git(work, ["add", "-A"]);
      git(work, ["commit", "-q", "-m", "rewritten"]);
      git(work, ["push", "-q", "-f", "origin", "HEAD:main"]);
      const after = git(work, ["rev-parse", "HEAD"]);
      setAi("review_push", review([]));
      const run = await ci(before, after);
      check(run.code === 0, `CI exit ${run.code}: ${run.stderr}`);
      const row = await reviewDone(after);
      check(row.status === "done", `review ${row.status}`);
      check(
        row.base_sha === before,
        "the review does not name the push's own before",
      );
      check(
        issue(tokenIssue)?.state === "open",
        "the open issue was closed by the force-push",
      );
      check(
        issue(tokenIssue)?.comments.length === comments,
        "the force-push commented on the open issue",
      );
      const open = await db<{ state: string }>(
        `SELECT state FROM watch_issues WHERE issue_number = ?`,
        tokenIssue,
      );
      check(open[0]?.state === "open", `tracked state ${open[0]?.state}`);
    },
  );

  await scenario(
    "11 pushes in a row: queue, then cancel-and-merge",
    async () => {
      setAi("review_push", review([]));
      const a = push({ "a.txt": "1\n" }, "a");
      const b = push({ "b.txt": "1\n" }, "b");
      await webhook("push", pushPayload(REPO, a.before, a.after));
      await webhook("push", pushPayload(REPO, b.before, b.after));
      check(
        (await reviewDone(a.after)).status === "done",
        "queued push a not reviewed",
      );
      check(
        (await reviewDone(b.after)).status === "done",
        "queued push b not reviewed",
      );
      check(
        (await patchRepo(REPO, { watchPushMode: "cancel-and-merge" })) === 200,
        "setting the mode failed",
      );
      setDelay(2500);
      const c = push({ "c.txt": "1\n" }, "c");
      await webhook("push", pushPayload(REPO, c.before, c.after));
      const waiting = ci(c.before, c.after);
      await waitFor(
        "push c to start",
        async () => (await pushReview(c.after))?.status === "running",
      );
      const d = push({ "d.txt": "1\n" }, "d");
      await webhook("push", pushPayload(REPO, d.before, d.after));
      const merged = await reviewDone(d.after);
      check(
        merged.base_sha === c.before,
        `the merged review starts at ${merged.base_sha.slice(0, 7)}, not ${c.before.slice(0, 7)}`,
      );
      const old = await db<{ status: string; cancel_reason: string }>(
        `SELECT j.status, j.cancel_reason FROM jobs j JOIN reviews r ON r.job_id = j.id
       WHERE r.kind = 'push' AND r.head_sha = ?`,
        c.after,
      );
      check(
        old[0]?.status === "canceled" && old[0]?.cancel_reason === "merged",
        `push c job ${old[0]?.status}/${old[0]?.cancel_reason}`,
      );
      const run = await waiting;
      check(run.code === 0, `CI for the merged push exited ${run.code}`);
      check(
        run.stdout.includes("merged into the review of a newer push"),
        "no merged notice",
      );
      setDelay(0);
      await patchRepo(REPO, { watchPushMode: "queue" });
    },
  );

  await scenario(
    "12 timeout: green with a notice, the review goes on",
    async () => {
      setDelay(8000);
      setAi("review_push", review([]));
      const next = push({ "slow.txt": "1\n" }, "slow");
      const run = await ci(next.before, next.after, { timeout: "0.05" });
      check(run.code === 0, `CI exit ${run.code}`);
      check(
        run.stdout.includes("::notice") && run.stdout.includes("still running"),
        "no timeout notice",
      );
      setDelay(0);
      check(
        (await reviewDone(next.after)).status === "done",
        "the review did not finish on the server",
      );
    },
  );

  await scenario("13 server down or a bad token: red", async () => {
    const head = git(work, ["rev-parse", "HEAD"]);
    const parent = git(work, ["rev-parse", "HEAD~1"]);
    const down = await ci(parent, head, {
      host: `http://127.0.0.1:${await freePort()}`,
    });
    check(down.code !== 0, "server down was green");
    const bad = await ci(parent, head, { token: "cmr_wrong" });
    check(bad.code !== 0, "a bad token was green");
  });

  await scenario("14 + 20 repository not initialized", async () => {
    const next = push({ "fresh.txt": "1\n" }, "fresh");
    const result = await webhook(
      "push",
      pushPayload(FRESH, next.before, next.after),
    );
    check(
      result.reason === "not-initialized",
      `webhook reason ${String(result.reason)}`,
    );
    const skipped = await waitFor("the skipped check run", () =>
      github.state.checkRuns.find(
        (r) => r.head_sha === next.after && r.conclusion === "skipped",
      ),
    );
    check(
      skipped.output?.title === "This repository is not initialized.",
      `title ${skipped.output?.title}`,
    );
    const run = await ci(next.before, next.after, { repo: FRESH });
    check(run.code === 0, `CI with the App exited ${run.code}`);
    check(run.stdout.includes("not initialized"), "no not-initialized notice");
    // The same repository with no App installation.
    await dbWrite(
      `UPDATE repos SET installation_id = NULL WHERE full_name = ?`,
      FRESH,
    );
    const other = push({ "fresh2.txt": "1\n" }, "fresh again");
    const red = await ci(other.before, other.after, { repo: FRESH });
    check(red.code !== 0, "with no App a not-initialized repository was green");
  });

  await scenario("15 open issues turned off", async () => {
    check(
      (await patchRepo(REPO, { watchOpenIssues: false })) === 200,
      "setting failed",
    );
    setAi(
      "review_push",
      review([
        finding("P1", "src/pay/coupon.ts", 1, 1, "coupon applies twice"),
      ]),
    );
    const count = github.state.issues.length;
    const next = push(
      {
        "src/pay/coupon.ts":
          "export const coupon = (x: number) => x * 0.5 * 0.5;\n",
      },
      "coupon",
    );
    await webhook("push", pushPayload(REPO, next.before, next.after));
    await reviewDone(next.after);
    check(
      github.state.issues.length === count,
      "an issue was opened with the setting off",
    );
    const run = github.state.checkRuns.find((r) => r.head_sha === next.after);
    check(
      (run?.output?.annotations ?? []).length === 1,
      "the finding is not on the check run",
    );
    await patchRepo(REPO, { watchOpenIssues: true });
  });

  await scenario("16 only P2 and P3: no issue", async () => {
    setAi(
      "review_push",
      review([
        finding("P2", "src/net/backoff.ts", 1, 1, "backoff has no cap"),
        finding("P3", "src/net/backoff.ts", 2, 2, "unused import"),
      ]),
    );
    const count = github.state.issues.length;
    const next = push(
      {
        "src/net/backoff.ts":
          "export const backoff = (n: number) => 2 ** n;\nimport fs from 'node:fs';\n",
      },
      "backoff",
    );
    const run = await ci(next.before, next.after);
    check(run.code === 0, `CI exit ${run.code}`);
    check(
      run.stdout.includes("::warning") && !run.stdout.includes("::error"),
      "findings are not warnings",
    );
    check(
      github.state.issues.length === count,
      "an issue was opened for P2/P3",
    );
  });

  await scenario(
    "17 + 19 App and CI on the same push: one review",
    async () => {
      setAi("review_push", review([]));
      const next = push({ "same.txt": "1\n" }, "same");
      await webhook("push", pushPayload(REPO, next.before, next.after));
      const run = await ci(next.before, next.after);
      check(run.code === 0, `CI exit ${run.code}`);
      check(
        run.stderr.includes("already reviewing this push"),
        "CI did not attach to the App's review",
      );
      const rows = await db<{ n: number }>(
        `SELECT COUNT(*) AS n FROM reviews WHERE kind = 'push' AND head_sha = ?`,
        next.after,
      );
      check(Number(rows[0]?.n) === 1, `${rows[0]?.n} reviews for one push`);
    },
  );

  await scenario("18 App: a push to another branch is ignored", async () => {
    const result = await webhook(
      "push",
      pushPayload(REPO, "1".repeat(40), "2".repeat(40), "refs/heads/feature"),
    );
    check(result.outcome === "ignored", `outcome ${String(result.outcome)}`);
  });

  await scenario("22 App: a missed push is not caught up later", async () => {
    setAi("review_push", review([]));
    push({ "missed.txt": "1\n" }, "missed while the server was down");
    const next = push({ "seen.txt": "1\n" }, "seen");
    await webhook("push", pushPayload(REPO, next.before, next.after));
    const row = await reviewDone(next.after);
    check(
      row.base_sha === next.before,
      "the review reached back to the missed push",
    );
  });

  await scenario("23 fixed, but no permission to close", async () => {
    setAi(
      "review_push",
      review([finding("P1", "src/billing/fee.ts", 1, 1, "fee is negative")]),
    );
    const add = push(
      { "src/billing/fee.ts": "export const fee = -1;\n" },
      "fee",
    );
    await webhook("push", pushPayload(REPO, add.before, add.after));
    await reviewDone(add.after);
    const number = github.state.issues.length;
    github.state.closeDenied = true;
    setAi("review_push", review([], ["- F1: closed"]));
    const fix = push(
      { "src/billing/fee.ts": "export const fee = 1;\n" },
      "fee: fix",
    );
    await webhook("push", pushPayload(REPO, fix.before, fix.after));
    await reviewDone(fix.after);
    const bodies = issue(number)?.comments.map((c) => c.body) ?? [];
    check(
      bodies.some((b) => b.endsWith(". Closing.")),
      "no fixed comment",
    );
    check(
      bodies.at(-1) ===
        "I tried to close this issue, but I do not have permission to close issues in this repository.",
      `last comment: ${bodies.at(-1)}`,
    );
    check(
      issue(number)?.state === "open",
      "the issue closed without permission",
    );
    github.state.closeDenied = false;
  });

  await scenario(
    "24 the code moves to another file: the model follows it",
    async () => {
      setAi(
        "review_push",
        review([finding("P1", "src/old/auth.ts", 1, 1, "secret is hardcoded")]),
      );
      const add = push(
        { "src/old/auth.ts": "export const SECRET = 'hunter2';\n" },
        "auth",
      );
      await webhook("push", pushPayload(REPO, add.before, add.after));
      await reviewDone(add.after);
      const number = github.state.issues.length;
      check(
        issue(number)?.title.startsWith("[P1] secret is hardcoded"),
        "no issue to follow",
      );
      // The file is deleted and its code lands in a different new one (too
      // different for git to call it a rename). Deleting alone is not a fix:
      // the model is told so and points at the new place.
      rmSync(join(work, "src/old/auth.ts"));
      setAi("review_push", review([], ["- F1: open src/new/auth.ts:6-6"]));
      const move = push(
        {
          "src/new/auth.ts": [
            "// credentials module",
            'import { env } from "node:process";',
            'export const REGION = env.REGION ?? "eu";',
            "export const TIMEOUT_SECONDS = 30;",
            "export const RETRIES = 3;",
            "export const SECRET = 'hunter2';",
            "",
          ].join("\n"),
        },
        "move auth",
      );
      await webhook("push", pushPayload(REPO, move.before, move.after));
      await reviewDone(move.after);
      const prompt =
        aiRequests()
          .filter((r) => r.job === "review_push")
          .at(-1)?.prompt ?? "";
      check(
        prompt.includes("If this code moved to another place in the DIFF"),
        "the model was not told the file is gone",
      );
      check(
        /is a new\s+finding/.test(prompt),
        "the model was not told other code is a new finding",
      );
      check(
        issue(number)?.state === "open",
        "a deleted file closed the issue on its own",
      );
      check(
        (issue(number)?.comments.at(-1)?.body ?? "").includes("still found"),
        "no still found comment",
      );
      const moved = await db<{ path: string }>(
        `SELECT path FROM watch_issues WHERE issue_number = ?`,
        number,
      );
      check(
        moved[0]?.path === "src/new/auth.ts",
        `the issue stays at ${moved[0]?.path}`,
      );
      // A rename carries the issue along with no comment and no verdict.
      const count = issue(number)?.comments.length ?? 0;
      git(work, ["mv", "src/new/auth.ts", "src/new/credentials.ts"]);
      git(work, ["commit", "-q", "-m", "rename auth"]);
      const renameBefore = git(work, ["rev-parse", "HEAD~1"]);
      git(work, ["push", "-q", "origin", "HEAD:main"]);
      const renameAfter = git(work, ["rev-parse", "HEAD"]);
      setAi("review_push", review([]));
      await webhook("push", pushPayload(REPO, renameBefore, renameAfter));
      await reviewDone(renameAfter);
      const renamed = await db<{ path: string }>(
        `SELECT path FROM watch_issues WHERE issue_number = ?`,
        number,
      );
      check(
        renamed[0]?.path === "src/new/credentials.ts",
        `after the rename the issue is at ${renamed[0]?.path}`,
      );
      check(
        issue(number)?.comments.length === count,
        "a plain rename commented on the issue",
      );
    },
  );

  await scenario("dashboard: the Pushes tab and the card", async () => {
    const pushes = await page(`/repos/${REPO}/pushes`);
    check(pushes.includes("<h1>Pushes</h1>"), "no Pushes page");
    // The App's events are cached for a minute, so either answer is right.
    check(
      /This repository is via (the GitHub App|CI)/.test(pushes),
      "the page does not say how the repo is watched",
    );
    check(/<td>App(?: and CI)?<\/td>/.test(pushes), "no App row");
    const overview = await page(`/repos/${REPO}`);
    check(
      overview.includes("Watching via"),
      "the card does not say it is watching",
    );
    check(overview.includes("Last push"), "the card has no last push");
    const settings = await page(`/repos/${REPO}/settings`);
    check(
      settings.includes("Open a GitHub issue for each P0 and P1 finding"),
      "no issues toggle",
    );
    check(
      settings.includes("Cancel and merge into the newest"),
      "no push mode control",
    );
    check(
      (await patchRepo(REPO, { watchPushMode: "sideways" })) === 422,
      "a bad push mode was accepted",
    );
  });
}

try {
  await main();
} catch (error) {
  failures.push(
    `setup: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
} finally {
  serveProc?.kill("SIGTERM");
  await (github as FakeGithub | undefined)?.stop().catch(() => {});
  if (failures.length > 0) {
    appendFileSync(join(sandbox, "serve.log"), serveLog);
    console.error(
      `\n${failures.length} failure(s):\n- ${failures.join("\n- ")}`,
    );
    console.error(`serve log: ${join(sandbox, "serve.log")}`);
    process.exitCode = 1;
  } else {
    rmSync(sandbox, { recursive: true, force: true });
    console.log("\ncommit watch smoke passed");
  }
}
