/** Live e2e against a real private test repo and a running `serve`.
 * Assertions are on GitHub state. `CM_FAKE_AI=1` is refused.
 *
 *   E2E_REPO=owner/repo deno task e2e
 *
 * Optional: `E2E_BASE` (default http://localhost:5000), `E2E_TIMEOUT_MS`,
 * `E2E_INSTALLATION_ID`. Uses the same `CM_CONFIG_PATH` as `serve` when
 * signing the webhook. GitHub cannot always reach this host, so the script
 * POSTs `opened` to `/github/webhook` after the PR exists. */
import { readConfig } from "../src/config.ts";
import { hmacSha256Hex } from "../src/server/webhook/signature.ts";

const repo = Deno.env.get("E2E_REPO");
if (!repo) throw new Error("E2E_REPO is required, e.g. owner/repo");
if (Deno.env.get("CM_FAKE_AI") === "1") {
  throw new Error(
    "e2e refuses CM_FAKE_AI=1. Unset it and use a real provider.",
  );
}

const base = Deno.env.get("E2E_BASE") ?? "http://localhost:5000";
const repos = Deno.env.get("CM_REPOS_DIR");
if (!repos) {
  throw new Error("CM_REPOS_DIR must match the running serve process");
}
const timeoutMs = Number(Deno.env.get("E2E_TIMEOUT_MS") ?? 900_000);
const installationId = Number(Deno.env.get("E2E_INSTALLATION_ID") || 0);
const branch = `e2e-${Date.now()}`;
const seedPath = `e2e-seed-${Date.now()}.ts`;
const guidePath = `${repos}/${repo}/PR_REVIEW_GUIDE.md`;
const seed = `export function run(userInput: string): unknown {
  return eval(userInput);
}
`;
const fixtureGuide = `# PR review guide

## Before requesting review

- Do not pass untrusted input to eval.
`;

type GhUser = { login?: string; type?: string };
type GhPr = {
  number: number;
  html_url?: string;
  created_at?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  user?: GhUser;
  head?: { ref?: string };
  base?: { ref?: string };
};
type GhReview = {
  id: number;
  state?: string;
  body?: string;
  submitted_at?: string;
  user?: GhUser;
};

async function gh(args: string[]): Promise<string> {
  const result = await new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (!result.success) {
    throw new Error(stderr.trim() || stdout.trim() || `gh ${args.join(" ")}`);
  }
  return stdout;
}

async function ghJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await gh(args)) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBot(user: GhUser | undefined): boolean {
  if (!user) return false;
  if (user.type === "Bot") return true;
  return (user.login ?? "").endsWith("[bot]");
}

async function postWebhook(pr: GhPr): Promise<void> {
  const payload: Record<string, unknown> = {
    action: "opened",
    number: pr.number,
    pull_request: {
      number: pr.number,
      draft: false,
      user: { login: pr.user?.login, type: pr.user?.type ?? "User" },
      additions: pr.additions ?? 1,
      deletions: pr.deletions ?? 0,
      changed_files: pr.changed_files ?? 1,
    },
    repository: { full_name: repo },
  };
  if (installationId > 0) payload.installation = { id: installationId };
  const body = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": "pull_request",
    "x-github-delivery": crypto.randomUUID(),
  };
  const secret = readConfig().githubWebhookSecret;
  if (secret) {
    headers["x-hub-signature-256"] = `sha256=${await hmacSha256Hex(
      secret,
      bytes,
    )}`;
  }
  const response = await fetch(`${base}/github/webhook`, {
    method: "POST",
    headers,
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`webhook ${response.status}: ${text}`);
  }
  const result = JSON.parse(text) as { outcome?: string; reason?: string };
  if (result.outcome !== "enqueued") {
    throw new Error(`webhook did not enqueue: ${text}`);
  }
  console.log(`webhook enqueued ${text}`);
}

async function waitForFinding(
  prNumber: number,
  createdAt: string,
): Promise<GhReview> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reviews = await ghJson<GhReview[]>([
      "api",
      `repos/${repo}/pulls/${prNumber}/reviews`,
    ]);
    const mine = reviews.filter((review) =>
      isBot(review.user) &&
      (review.submitted_at ?? "") >= createdAt
    );
    const withFindings = mine.find((review) =>
      review.state === "CHANGES_REQUESTED" ||
      (review.body ?? "").includes("See the inline comments.") ||
      (review.body ?? "").includes("could not be pinned")
    );
    if (withFindings) return withFindings;
    const empty = mine.find((review) =>
      (review.body ?? "").includes("No actionable findings.")
    );
    if (empty) {
      throw new Error(
        `bot posted review ${empty.id} with zero findings`,
      );
    }
    await sleep(5000);
  }
  throw new Error(`timed out waiting for a bot review on ${repo}#${prNumber}`);
}

async function cleanup(prNumber: number | undefined): Promise<void> {
  try {
    if (prNumber !== undefined) {
      await gh([
        "api",
        "--method",
        "PATCH",
        `repos/${repo}/pulls/${prNumber}`,
        "-f",
        "state=closed",
      ]);
    }
  } catch (error) {
    console.error(`close PR failed: ${error}`);
  }
  try {
    await gh([
      "api",
      "--method",
      "DELETE",
      `repos/${repo}/git/refs/heads/${branch}`,
    ]);
  } catch (error) {
    console.error(`delete branch failed: ${error}`);
  }
  if (fixtureGuideWritten) {
    try {
      if (originalGuide) await Deno.writeFile(guidePath, originalGuide);
      else await Deno.remove(guidePath);
    } catch (error) {
      console.error(`restore review guide failed: ${error}`);
    }
  }
}

const ping = await fetch(base);
if (!ping.ok && ping.status !== 303) {
  throw new Error(`serve is not reachable at ${base} (${ping.status})`);
}

const repoInfo = await ghJson<{ default_branch: string }>([
  "api",
  `repos/${repo}`,
]);
const defaultBranch = repoInfo.default_branch;
const ref = await ghJson<{ object: { sha: string } }>([
  "api",
  `repos/${repo}/git/ref/heads/${defaultBranch}`,
]);
await gh([
  "api",
  "--method",
  "POST",
  `repos/${repo}/git/refs`,
  "-f",
  `ref=refs/heads/${branch}`,
  "-f",
  `sha=${ref.object.sha}`,
]);

await Deno.mkdir(`${repos}/${repo}`, { recursive: true });
let originalGuide: Uint8Array | undefined;
let fixtureGuideWritten = false;
try {
  originalGuide = await Deno.readFile(guidePath);
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
await Deno.writeTextFile(guidePath, fixtureGuide);
fixtureGuideWritten = true;

let prNumber: number | undefined;
try {
  await gh([
    "api",
    "--method",
    "PUT",
    `repos/${repo}/contents/${seedPath}`,
    "-f",
    "message=e2e seeded defect",
    "-f",
    `content=${btoa(seed)}`,
    "-f",
    `branch=${branch}`,
  ]);
  const opened = await ghJson<GhPr>([
    "api",
    "--method",
    "POST",
    `repos/${repo}/pulls`,
    "-f",
    "title=e2e seeded defect",
    "-f",
    `head=${branch}`,
    "-f",
    `base=${defaultBranch}`,
    "-f",
    "body=Opened by scripts/e2e.ts. Close and delete after the run.",
  ]);
  prNumber = opened.number;
  console.log(`opened ${opened.html_url ?? `${repo}#${opened.number}`}`);

  let pr = opened;
  for (let i = 0; i < 10 && (pr.changed_files ?? 0) < 1; i++) {
    await sleep(1000);
    pr = await ghJson<GhPr>(["api", `repos/${repo}/pulls/${pr.number}`]);
  }
  if ((pr.changed_files ?? 0) < 1) {
    throw new Error(`PR #${pr.number} still has no changed files`);
  }

  await postWebhook(pr);
  const review = await waitForFinding(pr.number, pr.created_at ?? "");
  console.log(
    `ok review ${review.id} state=${review.state} on ${repo}#${pr.number}`,
  );
} finally {
  await cleanup(prNumber);
}
