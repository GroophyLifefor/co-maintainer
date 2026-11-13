/** A local review of a change larger than the diff budget, through the real
 * CLI against a fake model.
 *
 * Round 1 cannot fit every file, so it drops some, says so in `--json`, and
 * lists them under NOT SHOWN. Round 2 runs on the same change: the files
 * round 1 saw are unchanged and stay out, and the dropped files are sent
 * again, so the change is covered over two rounds with no flag. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Command,
  envToObject,
  mkdirPath,
  removePath,
  runtimeExecPath,
  runtimeRunArgs,
  tempDir,
  writeTextFile,
} from "../testing/runtime.ts";
import { test } from "node:test";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";
import { isolateTestFile } from "../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Small files: each is already smaller than a summary, so the plan can only
 * drop to make them fit. */
const FILES = 600;

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

function name(index: number): string {
  return `src/f${String(index).padStart(3, "0")}.ts`;
}

async function prepare(root: string) {
  const worktree = `${root}/worktree`;
  const configPath = `${root}/config.json`;
  const reposDir = `${root}/repos`;
  const repo = "acme/coverage";
  await mkdirPath(`${reposDir}/${repo}`, { recursive: true });
  await writeTextFile(
    `${reposDir}/${repo}/PR_REVIEW_GUIDE.md`,
    "# Review guide\n\nPrefer early returns.\n",
  );
  await writeTextFile(
    configPath,
    `${JSON.stringify({
      auth: "gh",
      ai: "openrouter",
      token: "fake-key",
      lowModel: "fake/model",
      highModel: "fake/model",
    })}\n`,
  );
  await mkdirPath(`${worktree}/src`, { recursive: true });
  await git(worktree, ["init"]);
  await git(worktree, ["config", "user.email", "t@t"]);
  await git(worktree, ["config", "user.name", "t"]);
  await writeTextFile(`${worktree}/README.md`, "base\n");
  await git(worktree, ["add", "README.md"]);
  await git(worktree, ["commit", "-m", "init"]);
  await git(worktree, ["branch", "-M", "main"]);
  await git(worktree, [
    "remote",
    "add",
    "origin",
    `https://github.com/${repo}.git`,
  ]);
  await git(worktree, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const line = (i: number, n: number) =>
    `export const v${i}_${n} = "${"x".repeat(40)}";`;
  for (let i = 0; i < FILES; i++) {
    const body = Array.from({ length: 8 }, (_, n) => line(i, n)).join("\n");
    await writeTextFile(`${worktree}/${name(i)}`, `${body}\n`);
  }
  await git(worktree, ["add", "src"]);
  await git(worktree, ["commit", "-m", "a large change"]);
  return { worktree, configPath, reposDir, repo };
}

async function review(
  root: string,
  env: { worktree: string; configPath: string; reposDir: string; repo: string },
  url: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await new Command(runtimeExecPath(), {
    args: runtimeRunArgs(join(projectRoot, "main.ts"), [
      "review",
      "--json",
      `--repo=${env.repo}`,
      "--disable-codegraph",
    ]),
    cwd: env.worktree,
    env: {
      ...envToObject(),
      CM_CONFIG_PATH: env.configPath,
      CM_REPOS_DIR: env.reposDir,
      CM_OPENROUTER_URL: url,
      LOCALAPPDATA: `${root}/localappdata`,
      XDG_CACHE_HOME: `${root}/cache`,
      CM_FAKE_AI: undefined,
      CM_FAKE_REVIEW_FILE: undefined,
    },
    stdout: "piped",
    stderr: "piped",
    timeoutMs: 120_000,
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

type Result = {
  revision: {
    files: number;
    truncated: boolean;
    coverage: {
      full: number;
      partial: string[];
      summarized: string[];
      dropped: string[];
      withheld: string[];
    };
  };
  warnings: { code: string }[];
};

function total(result: Result): number {
  const c = result.revision.coverage;
  return (
    c.full +
    c.partial.length +
    c.summarized.length +
    c.dropped.length +
    c.withheld.length
  );
}

test("a change over the diff budget is dropped honestly and covered by the next round", async () => {
  const root = await tempDir({ prefix: "cm-coverage-" });
  const prompts: string[] = [];
  const server = await startFakeOpenRouter("success", {
    chatContent: (prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ findings: [] });
    },
  });
  try {
    const env = await prepare(root);
    const first = await review(root, env, server.url);
    const one = JSON.parse(first.stdout) as Result;
    if (one.revision.files !== FILES) {
      throw new Error(`files: ${one.revision.files}\n${first.stderr}`);
    }
    if (total(one) !== FILES) {
      throw new Error(`states do not add up: ${JSON.stringify(one.revision)}`);
    }
    const dropped = one.revision.coverage.dropped;
    if (!one.revision.truncated || dropped.length === 0) {
      throw new Error(`round 1 should drop files: ${first.stdout}`);
    }
    if (!one.warnings.some((warning) => warning.code === "diff_dropped")) {
      throw new Error(`no diff_dropped warning: ${first.stdout}`);
    }
    const last = name(FILES - 1);
    if (!dropped.includes(last)) {
      throw new Error("files are dropped from the end of path order");
    }
    const firstPrompt = prompts.at(-1) ?? "";
    if (!firstPrompt.includes(`NOT SHOWN (diff budget)`)) {
      throw new Error("round 1 prompt lacks the NOT SHOWN list");
    }
    if (firstPrompt.includes(`FILE: ${last}`)) {
      throw new Error("a dropped file must not be in the DIFF section");
    }

    const second = await review(root, env, server.url);
    const two = JSON.parse(second.stdout) as Result;
    const secondPrompt = prompts.at(-1) ?? "";
    if (!secondPrompt.includes(`FILE: ${last}`)) {
      throw new Error("round 2 must send the file round 1 dropped");
    }
    if (secondPrompt.includes(`FILE: ${name(0)}\n`)) {
      throw new Error("round 2 must not resend a file round 1 saw");
    }
    if (two.revision.truncated || two.revision.coverage.full !== FILES) {
      throw new Error(`round 2 should cover everything: ${second.stdout}`);
    }
    if (two.warnings.some((warning) => warning.code === "diff_dropped")) {
      throw new Error(`round 2 dropped nothing: ${second.stdout}`);
    }
  } finally {
    await server.close();
    await removePath(root, { recursive: true });
  }
});
