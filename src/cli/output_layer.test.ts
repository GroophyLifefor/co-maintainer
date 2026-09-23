/** One presentation layer for local, PR and remote reviews (CORE-43).
 *
 * F21: a terminal printed the fixed four-line severity legend and the sentence
 * "If you'd like me to explain it in more detail, please ask." — neither has a
 * reader there. F22: a PR review printed Markdown sections while a local review
 * printed `New (1) •` and a `Summary:` line, so the same tool looked like two
 * products. F23: the header said `guide unknown` when the code was only unsure
 * of the *date*, and JSON claimed `codegraph.state: "used"` while stderr said
 * codegraph was missing.
 *
 * These run the real CLI for the local and remote paths and assert the same
 * header shape, the same summary line, and the absence of the terminal-hostile
 * text. The severity legend and the "ask" sentence still belong to the GitHub
 * comment, which is a different reader; `src/services/review.test.ts` covers
 * that side.
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
import { startFakeRemote, writeCaCert } from "../testing/fake_remote.ts";
import {
  createCliHarness,
  writeHarnessConfig,
} from "../testing/cli_harness.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Text that must never reach a terminal (F21). */
const TERMINAL_NOISE = [
  "If you'd like me to explain it in more detail, please ask.",
  "P0: Critical",
];

function assertCleanHeader(output: string, mode: string): void {
  for (const noise of TERMINAL_NOISE) {
    if (output.includes(noise)) {
      throw new Error(`${mode} output kept terminal noise:\n${output}`);
    }
  }
  if (!output.includes("co-maintainer review · ")) {
    throw new Error(`${mode} has no shared header:\n${output}`);
  }
  if (!output.includes("guide ")) {
    throw new Error(`${mode} header does not name the guide:\n${output}`);
  }
  if (!output.includes("codegraph ")) {
    throw new Error(`${mode} header does not name codegraph:\n${output}`);
  }
  if (!/Summary: \d+ new · \d+ open · \d+ closed · \d+ blocking/.test(output)) {
    throw new Error(`${mode} has no shared summary line:\n${output}`);
  }
}

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

async function prepareWorktree(
  root: string,
  repo: string,
): Promise<{ worktree: string; configPath: string; reposDir: string }> {
  const worktree = `${root}/worktree`;
  const configPath = `${root}/config.json`;
  const reposDir = `${root}/repos`;
  await mkdir(`${reposDir}/${repo}`, { recursive: true });
  await writeTextFile(
    `${reposDir}/${repo}/PR_REVIEW_GUIDE.md`,
    "# Review guide\n\nBe terse.\n",
  );
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
  await mkdir(worktree, { recursive: true });
  await git(worktree, ["init"]);
  await git(worktree, ["config", "user.email", "t@t"]);
  await git(worktree, ["config", "user.name", "t"]);
  await writeTextFile(`${worktree}/x.ts`, "export {}\n");
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
  return { worktree, configPath, reposDir };
}

const REVIEW_JSON = JSON.stringify({
  findings: [
    {
      severity: "P2",
      blocking: false,
      path: "x.ts",
      lineFrom: 1,
      lineTo: 1,
      title: "The exported constant is not validated",
      body: "This value is used as a bound downstream.",
    },
  ],
});

test("local review prints the shared human format, with the real guide date", async () => {
  const root = await makeTempDir({ prefix: "cm-core43-local-" });
  const server = await startFakeOpenRouter("success", {
    reviewJson: REVIEW_JSON,
  });
  try {
    const repo = "e2e-core43/local";
    const { worktree, configPath, reposDir } = await prepareWorktree(
      root,
      repo,
    );
    const result = await new Command(runtimeExecPath(), {
      args: runtimeRunArgs(join(projectRoot, "main.ts"), [
        "review",
        `--repo=${repo}`,
        // Codegraph is requested by default but cannot be prepared (the tools
        // dir is empty and there is no terminal), so the header must say
        // `unavailable` rather than claiming it was used (F23).
      ]),
      cwd: worktree,
      env: {
        ...envToObject(),
        CM_CONFIG_PATH: configPath,
        CM_REPOS_DIR: reposDir,
        CM_OPENROUTER_URL: server.url,
        // An empty tools dir: codegraph can never be present on this host.
        CM_TOOLS_DIR: `${root}/tools`,
        LOCALAPPDATA: `${root}/localappdata`,
        XDG_CACHE_HOME: `${root}/cache`,
        CM_FAKE_AI: undefined,
        CM_FAKE_REVIEW_FILE: undefined,
      },
      stdout: "piped",
      stderr: "piped",
      timeoutMs: 60_000,
    }).output();
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    assertCleanHeader(stdout, "local");
    if (!stdout.includes("codegraph unavailable")) {
      throw new Error(
        `codegraph was requested but absent; the header must say so:\n${stdout}\n${stderr}`,
      );
    }
    // F23: the source of the guide timestamp is the file on disk, so a local
    // review can print a date instead of "guide unknown".
    if (stdout.includes("guide unknown")) {
      throw new Error(`local review still has no guide date:\n${stdout}`);
    }
    if (!/guide built \d{4}-\d{2}-\d{2}/.test(stdout)) {
      throw new Error(`the guide date is not rendered:\n${stdout}`);
    }
    if (!stdout.includes("[P2 · non-blocking]")) {
      throw new Error(`the finding is not labeled:\n${stdout}`);
    }
  } finally {
    await server.close();
    await remove(root, { recursive: true });
  }
});

test("PR review prints the same format as the other two modes", async () => {
  const harness = await createCliHarness();
  const server = await startFakeOpenRouter("success", {
    reviewJson: REVIEW_JSON,
  });
  try {
    await writeHarnessConfig(`${harness.home}/config/config.json`, {
      auth: "gh",
      ai: "openrouter",
      token: "fake-key",
      lowModel: "fake/model",
      highModel: "fake/model",
    });
    // `fixture/repo` is the fake gh's fixed repository; its one pull request is
    // `src/app.ts`, whose guide the fake does not provide, so the review guide
    // comes from the repo directory the harness shares.
    await mkdir(`${harness.home}/repos/fixture/repo`, { recursive: true });
    await writeTextFile(
      `${harness.home}/repos/fixture/repo/PR_REVIEW_GUIDE.md`,
      "# Review guide\n\nBe terse.\n",
    );
    const result = await harness.run({
      args: [
        "review",
        "fixture/repo",
        "1",
        "--disable-codegraph",
        "--token=fake-key",
        "--high-model=fake/model",
      ],
      openrouterUrl: server.url,
    });
    const stdout = result.stdout;
    assertCleanHeader(stdout, "pr");
    if (!stdout.includes("PR #1")) {
      throw new Error(`the PR header is missing:\n${stdout}${result.stderr}`);
    }
    if (!stdout.includes("codegraph disabled")) {
      throw new Error(`--disable-codegraph is not reported:\n${stdout}`);
    }
    if (!/guide built \d{4}-\d{2}-\d{2}/.test(stdout)) {
      throw new Error(`the guide date is not rendered:\n${stdout}`);
    }
  } finally {
    await server.close();
    await harness.cleanup();
  }
});

test("remote review prints the same format as a local review", async () => {
  const remote = await startFakeRemote({
    repo: "e2e-core43/remote",
    sync: [
      {
        schemaVersion: 1,
        status: "done",
        logs: [],
        abort: null,
        result: {
          guide: { builtAt: "2026-09-15T10:00:00Z" },
          codegraph: { state: "used" },
          usage: { tokensIn: 10, tokensOut: 5, costUsd: 0 },
          summary: { new: 1, open: 0, closed: 0, blocking: 1 },
          findings: [
            {
              id: "f1",
              state: "new",
              closeReason: null,
              severity: "P1",
              blocking: true,
              path: "x.ts",
              lineFrom: 4,
              lineTo: 4,
              title: "the gate ignores its threshold",
              body: "A violation exactly at the threshold passes.",
              suggestion: null,
            },
          ],
        },
      },
    ],
  });
  const root = await makeTempDir({ prefix: "cm-core43-remote-" });
  try {
    const ca = await writeCaCert(root);
    const repo = "e2e-core43/remote";
    const { worktree, configPath, reposDir } = await prepareWorktree(
      root,
      repo,
    );
    const result = await new Command(runtimeExecPath(), {
      args: runtimeRunArgs(join(projectRoot, "main.ts"), [
        "review",
        "--remote",
        `--remote-host=${remote.url}`,
        "--remote-token=cmr_inline",
        "--disable-codegraph",
      ]),
      cwd: worktree,
      env: {
        ...envToObject(),
        CM_CONFIG_PATH: configPath,
        CM_REPOS_DIR: reposDir,
        NODE_EXTRA_CA_CERTS: ca,
      },
      stdout: "piped",
      stderr: "piped",
      timeoutMs: 60_000,
    }).output();
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    if (result.code !== 1) {
      throw new Error(`exit ${result.code}\n${stdout}\n${stderr}`);
    }
    assertCleanHeader(stdout, "remote");
    if (!stdout.includes("guide built 2026-09-15")) {
      throw new Error(`the remote guide date is missing:\n${stdout}`);
    }
    // F23: the state comes from the server's own report, not from the flag the
    // client happened to pass.
    if (!stdout.includes("codegraph used")) {
      throw new Error(
        `the remote header re-derived the state:\n${stdout}\n${stderr}`,
      );
    }
    if (!stdout.includes("[P1 · blocking]")) {
      throw new Error(`the remote finding is not labeled:\n${stdout}`);
    }
    if (!stdout.includes("1 new · 0 open · 0 closed · 1 blocking")) {
      throw new Error(`the remote summary line is wrong:\n${stdout}`);
    }
  } finally {
    await remove(root, { recursive: true });
    await remote.close();
  }
});
