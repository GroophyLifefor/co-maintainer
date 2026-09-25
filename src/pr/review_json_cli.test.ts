/** Structured review output end to end (CORE-40 / F02).
 *
 * The unit tests in `src/pr/findings_json.test.ts` pin the renderer and the
 * parser. These run the real CLI against the fake OpenRouter with a real
 * findings JSON answer, so the whole path is covered: the request carries
 * `response_format`, the answer is rendered to Markdown, the CLI parses it
 * back, and the finding reaches both the JSON output and the human output
 * without being cut. Before this task that path was the fallback parser, which
 * sliced the answer at fixed offsets and produced F02.
 */
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  envToObject,
  makeTempDir,
  mkdir,
  remove,
  writeTextFile,
} from "../util/runtime.ts";
import {
  Command,
  runtimeExecPath,
  runtimeRunArgs,
} from "../testing/runtime.ts";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Two findings on one file: the JSON shape the review asks for. The body is
 * long and ends in a word the old fallback would have cut mid-token. */
const REVIEW_JSON = JSON.stringify({
  findings: [
    {
      severity: "P1",
      blocking: true,
      path: "x.ts",
      lineFrom: 1,
      lineTo: 1,
      symbol: "y",
      title: "The exported constant is not validated",
      body: "This value is used as a bound downstream, so an unvalidated zero reaches the loop and it never terminates.",
      suggestion: "export const y = 1",
    },
    {
      severity: "P3",
      blocking: false,
      path: "x.ts",
      lineFrom: 1,
      title: "The name does not describe the value",
      body: "The name suggests a count but the value is a bound, which misleads every caller.",
    },
  ],
});

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await new Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

async function makeRepo(root: string, repo: string): Promise<string> {
  const repoDir = `${root}/repos/${repo}`;
  await mkdir(repoDir, { recursive: true });
  await writeTextFile(
    `${repoDir}/PR_REVIEW_GUIDE.md`,
    "# Review guide\n\nBe terse.\n",
  );
  const worktree = `${root}/worktree`;
  await mkdir(worktree, { recursive: true });
  await git(worktree, ["init"]);
  await git(worktree, ["config", "user.email", "t@t"]);
  await git(worktree, ["config", "user.name", "t"]);
  await writeTextFile(`${worktree}/x.ts`, "export const y = 0\n");
  await git(worktree, ["add", "x.ts"]);
  await git(worktree, ["commit", "-m", "init"]);
  await git(worktree, ["branch", "-M", "main"]);
  await git(worktree, [
    "remote",
    "add",
    "origin",
    `https://github.com/${repo}.git`,
  ]);
  await git(worktree, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await writeTextFile(`${worktree}/x.ts`, "export const y = 1\n");
  await git(worktree, ["commit", "-am", "change"]);
  return worktree;
}

async function runReview(
  root: string,
  worktree: string,
  repo: string,
  url: string,
  extra: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const configPath = `${root}/config.json`;
  await writeTextFile(
    configPath,
    `${JSON.stringify(
      {
        auth: "gh",
        ai: "openrouter",
        token: "fake-key",
        lowModel: "fake/model",
        highModel: "fake/model",
      },
      null,
      2,
    )}\n`,
  );
  const result = await new Command(runtimeExecPath(), {
    args: runtimeRunArgs(join(projectRoot, "main.ts"), [
      "review",
      `--repo=${repo}`,
      "--disable-codegraph",
      ...extra,
    ]),
    cwd: worktree,
    env: {
      ...envToObject(),
      CM_CONFIG_PATH: configPath,
      CM_REPOS_DIR: `${root}/repos`,
      CM_OPENROUTER_URL: url,
      LOCALAPPDATA: `${root}/localappdata`,
      XDG_CACHE_HOME: `${root}/cache`,
      CM_FAKE_AI: undefined,
      CM_FAKE_REVIEW_FILE: undefined,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

test("review: the request asks for the findings schema", async () => {
  const root = await makeTempDir({ prefix: "cm-core40-schema-" });
  const server = await startFakeOpenRouter("success", {
    reviewJson: REVIEW_JSON,
  });
  try {
    const repo = "e2e-core40/schema";
    const worktree = await makeRepo(root, repo);
    await runReview(root, worktree, repo, server.url, ["--json"]);
    const chat = server.requests.filter(
      (request) => request.response_format !== undefined,
    );
    if (chat.length === 0) {
      throw new Error(
        `no request carried response_format:\n${JSON.stringify(server.requests.map((request) => Object.keys(request)))}`,
      );
    }
  } finally {
    await server.close();
    await remove(root, { recursive: true });
  }
});

test("review --json: findings come through whole, not sliced", async () => {
  const root = await makeTempDir({ prefix: "cm-core40-json-" });
  const server = await startFakeOpenRouter("success", {
    reviewJson: REVIEW_JSON,
  });
  try {
    const repo = "e2e-core40/json";
    const worktree = await makeRepo(root, repo);
    const result = await runReview(root, worktree, repo, server.url, [
      "--json",
    ]);
    // A blocking P1 means exit 1 (CORE-10): the review ran and found something.
    if (result.code !== 1) {
      throw new Error(`exit ${result.code}:\n${result.stdout}${result.stderr}`);
    }
    const body = JSON.parse(result.stdout) as {
      findings?: {
        severity?: string;
        blocking?: boolean;
        path?: string | null;
        lineFrom?: number | null;
        title?: string;
        body?: string;
      }[];
    };
    const findings = body.findings ?? [];
    if (findings.length !== 2) {
      throw new Error(
        `expected 2 findings, got ${findings.length}: ${result.stdout}`,
      );
    }
    const [first, second] = findings;
    if (first.path !== "x.ts" || first.lineFrom !== 1) {
      throw new Error(`first finding: ${JSON.stringify(first)}`);
    }
    if (first.severity !== "P1" || first.blocking !== true) {
      throw new Error(`first severity: ${JSON.stringify(first)}`);
    }
    // The defect F02 described: the body was cut mid-token and the second
    // finding started inside the first one's prose. Both bodies must be whole
    // and distinct here.
    if (!first.body?.includes("it never terminates.")) {
      throw new Error(`first body cut: ${first.body}`);
    }
    if (/while\s*`?\w*$/.test(first.body ?? "")) {
      throw new Error(`first body ends mid-token: ${first.body}`);
    }
    if (!second.body?.startsWith("The name suggests a count")) {
      throw new Error(`second body starts off-target: ${second.body}`);
    }
    if (first.title === second.title) {
      throw new Error("the two findings share a title");
    }
  } finally {
    await server.close();
    await remove(root, { recursive: true });
  }
});

test("review: the human output shows the finding whole too", async () => {
  const root = await makeTempDir({ prefix: "cm-core40-human-" });
  const server = await startFakeOpenRouter("success", {
    reviewJson: REVIEW_JSON,
  });
  try {
    const repo = "e2e-core40/human";
    const worktree = await makeRepo(root, repo);
    const result = await runReview(root, worktree, repo, server.url, []);
    const output = `${result.stdout}${result.stderr}`;
    // Both findings are visible, each with its own prose, and no body was cut
    // mid-token the way F02 reported.
    if (!output.includes("it never terminates.")) {
      throw new Error(`first body missing from the output:\n${output}`);
    }
    if (!output.includes("The name suggests a count")) {
      throw new Error(`second body missing from the output:\n${output}`);
    }
    if (/while\s*`?\w*$/m.test(output)) {
      throw new Error(`a body is cut mid-token:\n${output}`);
    }
  } finally {
    await server.close();
    await remove(root, { recursive: true });
  }
});

test("review: a non-JSON answer is retried once and still reviewed", async () => {
  // A provider that ignores `response_format` answers prose instead. The CLI
  // must ask once more (CORE-40 step 3) and, when that fails too, fall back to
  // the legacy parser rather than dropping the review.
  const root = await makeTempDir({ prefix: "cm-core40-fallback-" });
  const server = await startFakeOpenRouter("success", {
    chatContent: () =>
      "## Findings\n\n### [P2 · non-blocking] `x.ts`: `y`\nLocation: `x.ts:1`\n\nThe prose path still works.\n",
  });
  try {
    const repo = "e2e-core40/fallback";
    const worktree = await makeRepo(root, repo);
    const result = await runReview(root, worktree, repo, server.url, [
      "--json",
    ]);
    if (result.code !== 0) {
      throw new Error(`exit ${result.code}:\n${result.stdout}${result.stderr}`);
    }
    const body = JSON.parse(result.stdout) as {
      findings?: { path?: string }[];
    };
    if ((body.findings ?? []).length !== 1) {
      throw new Error(`fallback findings: ${result.stdout}`);
    }
  } finally {
    await server.close();
    await remove(root, { recursive: true });
  }
});
