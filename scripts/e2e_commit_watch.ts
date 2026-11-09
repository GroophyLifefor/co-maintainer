/** Live commit watch e2e: real test repository, real GitHub, real AI.
 * Local only, never in CI. It costs money and pushes to the test
 * repository's default branch, so it says what it will cost first and waits
 * for a yes.
 *
 *   E2E_REPO=owner/repo CM_REPOS_DIR=... CM_REMOTE_TOKEN=... \
 *     node scripts/e2e_commit_watch.ts
 *
 * `E2E_STEPS=all` runs steps 1 to 3. The default runs only the first, so one
 * scenario proves the setup before the rest is paid for. Step 4 also needs
 * `E2E_IGNORE_STEP=1` and a server GitHub can reach.
 *
 * Needs a running `serve` (`E2E_BASE`, default http://localhost:5000) with
 * the GitHub App, its webhook secret and the test repository initialized,
 * the same `CM_CONFIG_PATH` and `CM_REPOS_DIR` as that `serve`, `gh` signed
 * in as a maintainer of the test repository (it writes the "ignore"
 * comment), `CM_REMOTE_TOKEN` (a remote review token, for the CI path) and
 * `E2E_PASSWORD` (the dashboard password, for the sync at the end).
 *
 * Steps, each checked on GitHub:
 * 1. App path: a pushed P0/P1 defect opens an issue.
 * 2. CI path (`review --remote --range`): a change to the defect's lines that
 *    does not fix it leaves "changed, still found".
 * 3. App path: the fix closes the issue with "no longer found ... Closing.".
 * 4. A maintainer's "ignore" comment gets "Noted", and the next sync puts the
 *    note in the detailed guide. */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { readConfig } from "../src/config.ts";
import { hmacSha256Hex } from "../src/server/webhook/signature.ts";
import { appDbPath } from "../src/store/app_db.ts";
import { getEnv } from "../src/util/runtime.ts";

const repo = getEnv("E2E_REPO");
if (!repo) throw new Error("E2E_REPO is required, e.g. owner/repo");
if (getEnv("CM_FAKE_AI") === "1") {
  throw new Error(
    "e2e refuses CM_FAKE_AI=1. Unset it and use a real provider.",
  );
}
const repos = getEnv("CM_REPOS_DIR");
if (!repos)
  throw new Error("CM_REPOS_DIR must match the running serve process");
const remoteToken = getEnv("CM_REMOTE_TOKEN");
if (!remoteToken)
  throw new Error("CM_REMOTE_TOKEN is required for the CI path");
const base = getEnv("E2E_BASE") ?? "http://localhost:5000";
const all = getEnv("E2E_STEPS") === "all";
const ignoreStep = getEnv("E2E_IGNORE_STEP") === "1";
const timeoutMs = Number(getEnv("E2E_TIMEOUT_MS") ?? 900_000);
const started = new Date().toISOString();
const root = join(import.meta.dirname, "..");
const path = `src/e2e_watch_${Date.now()}.ts`;

const BUG = `export function run(userInput: string): unknown {
  return eval(userInput);
}
`;
const STILL_BAD = `export function run(userInput: string): unknown {
  const code = String(userInput);
  return eval(code);
}
`;
const FIXED = `export function run(userInput: string): unknown {
  return JSON.parse(userInput);
}
`;

type Issue = {
  number: number;
  title: string;
  body: string;
  state: string;
  created_at: string;
  user?: { login?: string; type?: string };
};
type Comment = { body: string; user?: { login?: string; type?: string } };

function gh(args: string[]): string {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `gh ${args.join(" ")}`);
  return result.stdout;
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(what: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5000);
  }
}

const defaultBranch = ghJson<{ default_branch: string }>([
  "api",
  `repos/${repo}`,
]).default_branch;

function head(): string {
  return ghJson<{ object: { sha: string } }>([
    "api",
    `repos/${repo}/git/ref/heads/${defaultBranch}`,
  ]).object.sha;
}

/** Writes `path` on the default branch through the contents API: a real
 * push. Returns the push's before and after. */
function pushFile(
  content: string,
  message: string,
): { before: string; after: string } {
  const before = head();
  let sha: string | undefined;
  try {
    sha = ghJson<{ sha: string }>([
      "api",
      `repos/${repo}/contents/${path}?ref=${defaultBranch}`,
    ]).sha;
  } catch {
    sha = undefined;
  }
  gh([
    "api",
    "--method",
    "PUT",
    `repos/${repo}/contents/${path}`,
    "-f",
    `message=${message}`,
    "-f",
    `content=${Buffer.from(content).toString("base64")}`,
    "-f",
    `branch=${defaultBranch}`,
    ...(sha ? ["-f", `sha=${sha}`] : []),
  ]);
  return { before, after: head() };
}

async function webhook(before: string, after: string): Promise<void> {
  const body = JSON.stringify({
    ref: `refs/heads/${defaultBranch}`,
    before,
    after,
    repository: { full_name: repo, default_branch: defaultBranch },
  });
  const secret = readConfig().githubWebhookSecret;
  if (!secret)
    throw new Error("serve has no webhook secret in this CM_CONFIG_PATH");
  const response = await fetch(`${base}/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${await hmacSha256Hex(secret, new TextEncoder().encode(body))}`,
    },
    body,
  });
  const text = await response.text();
  // GitHub may have delivered the same push already when the App's Push event
  // is on, and then this one is the duplicate.
  if (
    !response.ok ||
    !(text.includes('"enqueued"') || text.includes("already-reviewed"))
  ) {
    throw new Error(`webhook: ${response.status} ${text}`);
  }
}

function botIssues(): Issue[] {
  return ghJson<Issue[]>([
    "api",
    `repos/${repo}/issues?labels=co-maintainer&state=all&since=${started}&per_page=50`,
  ]).filter(
    (issue) =>
      issue.created_at >= started &&
      (issue.user?.type === "Bot" ||
        (issue.user?.login ?? "").endsWith("[bot]")),
  );
}

function comments(number: number): Comment[] {
  return ghJson<Comment[]>([
    "api",
    `repos/${repo}/issues/${number}/comments?per_page=100`,
  ]);
}

/** The average cost of this server's recent reviews, from its own records. */
function averageReviewCost(): number | undefined {
  try {
    const db = new DatabaseSync(appDbPath(), { readOnly: true });
    try {
      const row = db
        .prepare(
          `SELECT AVG(cost) AS avg FROM (SELECT cost FROM reviews WHERE cost IS NOT NULL ORDER BY created_at DESC LIMIT 20)`,
        )
        .get() as { avg: number | null } | undefined;
      return row?.avg ?? undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

async function confirmCost(): Promise<void> {
  const reviews = all ? (ignoreStep ? 4 : 3) : 1;
  const comments = all && ignoreStep ? 1 : 0;
  const average = averageReviewCost();
  const estimate =
    average === undefined
      ? "unknown (no recorded review cost on this server yet)"
      : `about $${(average * reviews).toFixed(2)} (${reviews} push review(s) at the recent average of $${average.toFixed(3)}, plus ${comments} small comment call(s) and one sync)`;
  console.log(
    `This run pushes ${reviews + (all ? 1 : 0)} commit(s) to ${repo}@${defaultBranch} and costs ${estimate}.`,
  );
  if (getEnv("E2E_YES") === "1") return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Run it? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("Not run.");
    process.exit(0);
  }
}

async function ciReview(before: string, after: string): Promise<void> {
  const clone = join(tmpdir(), `cm-e2e-watch-${Date.now()}`);
  try {
    gh(["repo", "clone", repo!, clone, "--", "--quiet"]);
    const result = spawnSync(
      process.execPath,
      [
        join(root, "main.ts"),
        "review",
        "--remote",
        `--range=${before}..${after}`,
        `--branch=${defaultBranch}`,
        `--repo=${repo}`,
        "--output=github",
      ],
      {
        cwd: clone,
        encoding: "utf8",
        env: {
          ...process.env,
          CM_REMOTE_HOST: base,
          CM_REMOTE_TOKEN: remoteToken,
        },
      },
    );
    console.log(result.stdout);
    if (result.status !== 0)
      throw new Error(`CI path exited ${result.status}: ${result.stderr}`);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

async function login(): Promise<string> {
  const password = getEnv("E2E_PASSWORD");
  if (!password)
    throw new Error(
      "E2E_PASSWORD (the dashboard password) is required for the sync step",
    );
  const response = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(password)}`,
    redirect: "manual",
  });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("dashboard login failed");
  return cookie;
}

const ping = await fetch(base);
if (!ping.ok && ping.status !== 303)
  throw new Error(`serve is not reachable at ${base}`);
await confirmCost();

// The seeded defect must break a rule the guide names, or a review that
// follows the guide rightly reports nothing. The rule is added to the
// repository's own guide, which stays as it is otherwise, and the guide is
// put back at the end.
const guidePath = join(repos, repo, "PR_REVIEW_GUIDE.md");
let originalGuide: string | undefined;
try {
  originalGuide = readFileSync(guidePath, "utf8");
} catch {
  originalGuide = undefined;
}
writeFileSync(
  guidePath,
  `${(originalGuide ?? "# PR review guide\n").trimEnd()}\n\n## Commit watch e2e\n\n- Do not pass untrusted input to eval. This is P1.\n`,
);

let opened: Issue | undefined;
try {
  console.log("1. App path: a P0/P1 defect opens an issue");
  const add = pushFile(BUG, "e2e: commit watch seeded defect");
  await webhook(add.before, add.after);
  opened = await until("the issue", () =>
    botIssues().find((issue) => issue.body.includes(path)),
  );
  if (!/^\[P[01]\] /.test(opened.title))
    throw new Error(`title: ${opened.title}`);
  if (
    !opened.body.includes(
      `\`${add.before.slice(0, 7)}..${add.after.slice(0, 7)}\` on \`${defaultBranch}\``,
    )
  ) {
    throw new Error("the issue does not name the push");
  }
  console.log(`ok issue #${opened.number}: ${opened.title}`);
  if (!all) {
    console.log("First step passed. Run with E2E_STEPS=all for the rest.");
  } else {
    console.log("2. CI path: the defect's lines change but it is not fixed");
    const change = pushFile(STILL_BAD, "e2e: commit watch, still unsafe");
    await ciReview(change.before, change.after);
    await until("the still-found comment", () =>
      comments(opened!.number).find((c) =>
        c.body.includes("changed, still found by the review of"),
      ),
    );
    console.log("ok changed, still found");

    console.log("3. App path: the fix closes the issue");
    const fix = pushFile(FIXED, "e2e: commit watch, fixed");
    await webhook(fix.before, fix.after);
    await until("the closing", () => {
      const issue = ghJson<Issue>([
        "api",
        `repos/${repo}/issues/${opened!.number}`,
      ]);
      return issue.state === "closed" &&
        comments(opened!.number).some((c) => c.body.endsWith(". Closing."))
        ? issue
        : undefined;
    });
    console.log("ok closed by co-maintainer");
  }
  // The comment's webhook only reaches a public server, and a full sync costs
  // more than the rest of the run, so step 4 runs only when asked for.
  if (all && ignoreStep) {
    console.log("4. ignore: Noted, then the next sync writes the note");
    const again = pushFile(BUG, "e2e: commit watch, defect again");
    await webhook(again.before, again.after);
    const back = await until("the new issue", () =>
      botIssues().find(
        (issue) => issue.number !== opened!.number && issue.body.includes(path),
      ),
    );
    gh([
      "api",
      "--method",
      "POST",
      `repos/${repo}/issues/${back.number}/comments`,
      "-f",
      "body=@co-maintainer this eval is intended in this test repository, please ignore it.",
    ]);
    await until("the noted reply", () =>
      comments(back.number).find((c) =>
        c.body.startsWith(
          "Noted, I will take this into account on the next sync.",
        ),
      ),
    );
    const cookie = await login();
    const sync = await fetch(`${base}/api/repos/${repo}/remake`, {
      method: "POST",
      headers: {
        cookie,
        "x-requested-with": "co-maintainer",
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (!sync.ok) throw new Error(`sync did not start: ${sync.status}`);
    const guide = join(repos, repo, "PR_REVIEW_DETAILED_GUIDE.md");
    await until("the note in the detailed guide", () => {
      try {
        return readFileSync(guide, "utf8").includes("## Maintainer notes")
          ? true
          : undefined;
      } catch {
        return undefined;
      }
    });
    console.log("ok the note is in the detailed guide");
  }
} finally {
  try {
    if (originalGuide === undefined) rmSync(guidePath, { force: true });
    else writeFileSync(guidePath, originalGuide);
  } catch (error) {
    console.error(`restoring the review guide failed: ${error}`);
  }
  try {
    const sha = ghJson<{ sha: string }>([
      "api",
      `repos/${repo}/contents/${path}?ref=${defaultBranch}`,
    ]).sha;
    gh([
      "api",
      "--method",
      "DELETE",
      `repos/${repo}/contents/${path}`,
      "-f",
      "message=e2e: commit watch cleanup",
      "-f",
      `sha=${sha}`,
      "-f",
      `branch=${defaultBranch}`,
    ]);
  } catch (error) {
    console.error(`cleanup of ${path} failed: ${error}`);
  }
  for (const issue of botIssues()) {
    if (issue.state === "open") {
      try {
        gh([
          "api",
          "--method",
          "PATCH",
          `repos/${repo}/issues/${issue.number}`,
          "-f",
          "state=closed",
        ]);
      } catch (error) {
        console.error(`closing #${issue.number} failed: ${error}`);
      }
    }
  }
}
