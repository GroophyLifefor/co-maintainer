/** The cost and time summary line (CORE-26 / F18).
 *
 * Two layers: the formatter is pure and tested directly, and the three
 * commands that must print it (`init`, `sync`, `review`) run as real child
 * processes against the fake OpenRouter, because the point is that the line
 * lands on stderr without disturbing stdout.
 */
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatDuration,
  formatRunSummary,
  summaryFromMetrics,
} from "../util/run_summary.ts";
import {
  commandOutput,
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
import { fakeGhBin } from "../testing/cli_harness.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("run summary: the line matches the documented shape", () => {
  const line = formatRunSummary({
    durationMs: 21_000,
    tokensIn: 3125,
    tokensOut: 1308,
    costUsd: 0.0016,
  });
  if (line !== "Done in 21.0s · 3,125 in, 1,308 out tokens · $0.0016") {
    throw new Error(`line: ${line}`);
  }
});

test("run summary: an unknown cost says so instead of $0.0000", () => {
  const line = formatRunSummary({
    durationMs: 1500,
    tokensIn: 40,
    tokensOut: 12,
    costUsd: null,
  });
  if (!line.endsWith("· cost unknown")) {
    throw new Error(`line: ${line}`);
  }
});

test("run summary: a missing duration drops the time part", () => {
  const line = formatRunSummary({
    durationMs: null,
    tokensIn: 1,
    tokensOut: 2,
    costUsd: 0,
  });
  if (line.startsWith("Done in")) {
    throw new Error(`line: ${line}`);
  }
});

test("run summary: durations read as seconds, then minutes", () => {
  if (formatDuration(1300) !== "1.3s") {
    throw new Error(`1.3s: ${formatDuration(1300)}`);
  }
  if (formatDuration(59_400) !== "59.4s") {
    throw new Error(`59.4s: ${formatDuration(59_400)}`);
  }
  if (formatDuration(123_000) !== "2m 03s") {
    throw new Error(`2m 03s: ${formatDuration(123_000)}`);
  }
});

test("run summary: metrics with an unknown cost become a null dollar value", () => {
  const summary = summaryFromMetrics(
    {
      calls: 2,
      tokensIn: 10,
      tokensOut: 20,
      cost: 0,
      knownCalls: 0,
      unknownCalls: 2,
    },
    5000,
  );
  if (summary.costUsd !== null) throw new Error(`costUsd: ${summary.costUsd}`);
  if (
    summary.costNote !== "The provider did not report the cost for this review."
  ) {
    throw new Error(`costNote: ${summary.costNote}`);
  }
  const line = formatRunSummary(summary);
  if (
    !line.endsWith(
      "cost unknown (The provider did not report the cost for this review.)",
    )
  ) {
    throw new Error(`line: ${line}`);
  }
});

test("run summary: init prints the line on stderr and keeps stdout clean", async () => {
  const server = await startFakeOpenRouter("success");
  const root = await makeTempDir({ prefix: "cm-summary-init-" });
  try {
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
    const result = await commandOutput(runtimeExecPath(), {
      args: runtimeRunArgs(join(projectRoot, "main.ts"), [
        "init",
        "fixture/repo",
        "--include-codebase",
      ]),
      cwd: projectRoot,
      env: {
        ...envToObject(),
        CM_CONFIG_PATH: configPath,
        CM_REPOS_DIR: `${root}/repos`,
        CM_CLONES_DIR: `${root}/clones`,
        LOCALAPPDATA: `${root}/localappdata`,
        XDG_CACHE_HOME: `${root}/cache`,
        CM_OPENROUTER_URL: server.url,
        CM_GH_BIN: fakeGhBin().command,
        CM_GH_SCRIPT: fakeGhBin().script,
        CM_FAKE_AI: undefined,
        CM_FAKE_REVIEW_FILE: undefined,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    if (result.code !== 0) {
      throw new Error(`init exited ${result.code}:\n${stderr}`);
    }
    const want =
      /Done in [\d.]+s · [\d,]+ in, [\d,]+ out tokens · (\$\d|cost unknown)/;
    if (!want.test(stderr)) {
      throw new Error(`no summary line on stderr:\n${stderr}`);
    }
    if (stdout.includes("Done in")) {
      throw new Error(`the summary leaked into stdout:\n${stdout}`);
    }
  } finally {
    await remove(root, { recursive: true });
    await server.close();
  }
});

test("run summary: sync prints the line on stderr", async () => {
  const server = await startFakeOpenRouter("success");
  const root = await makeTempDir({ prefix: "cm-summary-sync-" });
  try {
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
    const env = {
      ...envToObject(),
      CM_CONFIG_PATH: configPath,
      CM_REPOS_DIR: `${root}/repos`,
      CM_CLONES_DIR: `${root}/clones`,
      LOCALAPPDATA: `${root}/localappdata`,
      XDG_CACHE_HOME: `${root}/cache`,
      CM_OPENROUTER_URL: server.url,
      CM_GH_BIN: fakeGhBin().command,
      CM_GH_SCRIPT: fakeGhBin().script,
      CM_FAKE_AI: undefined,
      CM_FAKE_REVIEW_FILE: undefined,
    };
    // sync needs a previous init for this repository, so build one first.
    const initRun = await commandOutput(runtimeExecPath(), {
      args: runtimeRunArgs(join(projectRoot, "main.ts"), [
        "init",
        "fixture/repo",
        "--include-codebase",
      ]),
      cwd: projectRoot,
      env,
      stdout: "piped",
      stderr: "piped",
    });
    if (initRun.code !== 0) {
      throw new Error("the priming init failed");
    }
    const syncRun = await commandOutput(runtimeExecPath(), {
      args: runtimeRunArgs(join(projectRoot, "main.ts"), [
        "sync",
        "fixture/repo",
        "--include-codebase",
      ]),
      cwd: projectRoot,
      env,
      stdout: "piped",
      stderr: "piped",
    });
    const stderr = new TextDecoder().decode(syncRun.stderr);
    if (syncRun.code !== 0) {
      throw new Error(`sync exited ${syncRun.code}:\n${stderr}`);
    }
    if (!/Done in [\d.]+s · [\d,]+ in, [\d,]+ out tokens/.test(stderr)) {
      throw new Error(`no summary line on sync stderr:\n${stderr}`);
    }
  } finally {
    await remove(root, { recursive: true });
    await server.close();
  }
});

test("run summary: review prints the line on stderr", async () => {
  const server = await startFakeOpenRouter("success");
  const root = await makeTempDir({ prefix: "cm-summary-review-" });
  try {
    const repo = "e2e-summary/repo";
    const repoDir = `${root}/repos/${repo}`;
    await mkdir(repoDir, { recursive: true });
    await writeTextFile(
      `${repoDir}/PR_REVIEW_GUIDE.md`,
      "# Review guide\n\nBe terse.\n",
    );
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
    const worktree = `${root}/worktree`;
    await mkdir(worktree, { recursive: true });
    const git = async (args: string[]): Promise<void> => {
      const r = await new Command("git", {
        args,
        cwd: worktree,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!r.success) {
        throw new Error(
          `git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`,
        );
      }
    };
    await git(["init"]);
    await git(["config", "user.email", "t@t"]);
    await git(["config", "user.name", "t"]);
    await writeTextFile(`${worktree}/x.ts`, "export {}\n");
    await git(["add", "x.ts"]);
    await git(["commit", "-m", "init"]);
    await git(["branch", "-M", "main"]);
    await git(["remote", "add", "origin", `https://github.com/${repo}.git`]);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await writeTextFile(`${worktree}/x.ts`, "export const y = 1\n");
    await git(["commit", "-am", "change"]);

    const result = await commandOutput(runtimeExecPath(), {
      args: runtimeRunArgs(join(projectRoot, "main.ts"), [
        "review",
        `--repo=${repo}`,
        "--disable-codegraph",
      ]),
      cwd: worktree,
      env: {
        ...envToObject(),
        CM_CONFIG_PATH: configPath,
        CM_REPOS_DIR: `${root}/repos`,
        CM_OPENROUTER_URL: server.url,
        LOCALAPPDATA: `${root}/localappdata`,
        XDG_CACHE_HOME: `${root}/cache`,
        CM_FAKE_AI: undefined,
        CM_FAKE_REVIEW_FILE: undefined,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const stderr = new TextDecoder().decode(result.stderr);
    if (!/Done in [\d.]+s · [\d,]+ in, [\d,]+ out tokens/.test(stderr)) {
      throw new Error(
        `no summary line on stderr (exit ${result.code}):\n${stderr}`,
      );
    }
  } finally {
    await remove(root, { recursive: true });
    await server.close();
  }
});
