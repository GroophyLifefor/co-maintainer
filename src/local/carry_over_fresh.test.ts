/** Carry-over must not shadow a fresh scan (CORE-42 / F03).
 *
 * F03: after the review guide was rebuilt, a local review still showed only the
 * old finding as "Still open" and reported nothing new; `--fresh` on the same
 * working tree immediately surfaced two real violations. The carry-over pass
 * had quietly replaced the review instead of running beside it.
 *
 * These tests drive the real CLI in a git worktree against a fake model that
 * mimics the reported behavior:
 *  - run 1 reports finding A and stores it as carry-over;
 *  - run 2 answers the carry prompt with the verdict alone, and reports the new
 *    violation B only when the prompt tells it to scan the diff afresh.
 *
 * Two fixes are pinned separately: the prompt now asks for both jobs (so even a
 * carry-over run finds B), and a guide rebuilt after the previous review makes
 * the run fresh automatically (so carry-over is not consulted at all).
 */
import { utimes } from "node:fs/promises";
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

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Finding A: the one the earlier review raised. */
const FINDING_A = {
  severity: "P1",
  blocking: true,
  path: "src/a.ts",
  lineFrom: 4,
  lineTo: 4,
  title: "The helper ignores its argument",
  body: "The value is never read, so the new behavior is not applied.",
};

/** Finding B: a genuinely new violation on a file the earlier review never
 * saw. It can only appear if the run scans the diff afresh. */
const FINDING_B = {
  severity: "P1",
  blocking: true,
  path: "src/b.ts",
  lineFrom: 2,
  lineTo: 2,
  title: "The new branch never terminates",
  body: "The loop bound is read from an unvalidated value.",
};

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

async function prepareWorktree(root: string): Promise<{
  worktree: string;
  configPath: string;
  reposDir: string;
  repo: string;
  guidePath: string;
}> {
  const worktree = `${root}/worktree`;
  const configPath = `${root}/config.json`;
  const reposDir = `${root}/repos`;
  const repo = "e2e-core42/carry";
  const guidePath = `${reposDir}/${repo}/PR_REVIEW_GUIDE.md`;
  await mkdirPath(`${reposDir}/${repo}`, { recursive: true });
  await writeTextFile(guidePath, "# Review guide\n\nPrefer early returns.\n");
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
  await writeTextFile(`${worktree}/src/a.ts`, "export const a = 0\n");
  await git(worktree, ["add", "src/a.ts"]);
  await git(worktree, ["commit", "-m", "init"]);
  await git(worktree, ["branch", "-M", "main"]);
  await git(worktree, [
    "remote",
    "add",
    "origin",
    `https://github.com/${repo}.git`,
  ]);
  await git(worktree, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  // The change the first review sees.
  await writeTextFile(`${worktree}/src/a.ts`, "export const a = 1\n");
  await git(worktree, ["commit", "-am", "change a"]);
  return { worktree, configPath, reposDir, repo, guidePath };
}

async function runReview(
  root: string,
  worktree: string,
  repo: string,
  configPath: string,
  reposDir: string,
  url: string,
  extra: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await new Command(runtimeExecPath(), {
    args: runtimeRunArgs(join(projectRoot, "main.ts"), [
      "review",
      "--json",
      `--repo=${repo}`,
      "--disable-codegraph",
      ...extra,
    ]),
    cwd: worktree,
    env: {
      ...envToObject(),
      CM_CONFIG_PATH: configPath,
      CM_REPOS_DIR: reposDir,
      CM_OPENROUTER_URL: url,
      LOCALAPPDATA: `${root}/localappdata`,
      XDG_CACHE_HOME: `${root}/cache`,
      CM_FAKE_AI: undefined,
      CM_FAKE_REVIEW_FILE: undefined,
    },
    stdout: "piped",
    stderr: "piped",
    timeoutMs: 60_000,
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

type Finding = {
  state?: string;
  path?: string | null;
  severity?: string;
  blocking?: boolean;
};

function findingsOf(stdout: string): Finding[] {
  const body = JSON.parse(stdout) as { findings?: Finding[] };
  return body.findings ?? [];
}

function has(stdout: string, path: string): boolean {
  return findingsOf(stdout).some((row) => row.path === path);
}

function openAt(stdout: string, path: string): boolean {
  return findingsOf(stdout).some(
    (row) => row.path === path && row.state === "open",
  );
}

/** The next diff includes a new file, so run 2 has something new to find. */
async function addSecondFile(worktree: string): Promise<void> {
  await writeTextFile(`${worktree}/src/b.ts`, "export const b = 0\n");
  await git(worktree, ["add", "src/b.ts"]);
  await git(worktree, ["commit", "-m", "add b"]);
}

test("a carry-over run still scans the diff and reports new findings", async () => {
  const root = await tempDir({ prefix: "cm-core42-prompt-" });
  let run = 1;
  const server = await startFakeOpenRouter("success", {
    chatContent: (prompt) => {
      if (run === 1) return JSON.stringify({ findings: [FINDING_A] });
      // The F03 model: with only a verdict task it answers the verdict and
      // stops; when told to scan afresh it also reports B.
      const fresh = /Scan the DIFF from scratch/i.test(prompt);
      return JSON.stringify({
        findings: fresh ? [FINDING_B] : [],
        previousFindings: [{ id: "F1", state: "open" }],
      });
    },
  });
  try {
    const { worktree, configPath, reposDir, repo } =
      await prepareWorktree(root);
    const first = await runReview(
      root,
      worktree,
      repo,
      configPath,
      reposDir,
      server.url,
    );
    if (!has(first.stdout, "src/a.ts")) {
      throw new Error(
        `run 1 did not report A:\n${first.stdout}${first.stderr}`,
      );
    }
    await addSecondFile(worktree);
    run = 2;
    const second = await runReview(
      root,
      worktree,
      repo,
      configPath,
      reposDir,
      server.url,
    );
    // The point of CORE-42: the new violation is found even though a carry-over
    // finding is in play.
    if (!has(second.stdout, "src/b.ts")) {
      throw new Error(
        `run 2 missed the new finding B:\n${second.stdout}${second.stderr}`,
      );
    }
  } finally {
    await server.close();
    await removePath(root, { recursive: true });
  }
});

test("a guide rebuilt after the last review starts fresh", async () => {
  const root = await tempDir({ prefix: "cm-core42-fresh-" });
  let run = 1;
  const server = await startFakeOpenRouter("success", {
    chatContent: (prompt) => {
      if (run === 1) return JSON.stringify({ findings: [FINDING_A] });
      // Here the model is deliberately unhelpful: if it is handed a carry-over
      // block at all it answers the verdict alone. Only a fresh run finds B,
      // so finding B proves the stale carry-over was discarded.
      const carry = /PREVIOUS FINDINGS/i.test(prompt);
      return JSON.stringify({
        findings: carry ? [] : [FINDING_B],
        previousFindings: carry ? [{ id: "F1", state: "open" }] : [],
      });
    },
  });
  try {
    const { worktree, configPath, reposDir, repo, guidePath } =
      await prepareWorktree(root);
    const first = await runReview(
      root,
      worktree,
      repo,
      configPath,
      reposDir,
      server.url,
    );
    if (!has(first.stdout, "src/a.ts")) {
      throw new Error(
        `run 1 did not report A:\n${first.stdout}${first.stderr}`,
      );
    }

    // Rebuild the guide, strictly after the first review. The mtime is what a
    // local review uses as the build time, since it never opens app.db.
    const later = new Date(Date.now() + 60_000);
    await writeTextFile(
      guidePath,
      "# Review guide\n\nPrefer early returns.\nAlways bound loops.\n",
    );
    await utimes(guidePath, later, later);

    await addSecondFile(worktree);
    run = 2;
    const second = await runReview(
      root,
      worktree,
      repo,
      configPath,
      reposDir,
      server.url,
    );
    if (!has(second.stdout, "src/b.ts")) {
      throw new Error(
        `a rebuilt guide did not start fresh, B missing:\n${second.stdout}${second.stderr}`,
      );
    }
    // Fresh means the old finding is gone, not carried as "Still open" and not
    // re-raised from memory.
    if (openAt(second.stdout, "src/a.ts")) {
      throw new Error(
        `the stale finding survived the rebuild:\n${second.stdout}`,
      );
    }
  } finally {
    await server.close();
    await removePath(root, { recursive: true });
  }
});

test("without a rebuild the previous finding is carried, not re-raised", async () => {
  const root = await tempDir({ prefix: "cm-core42-stable-" });
  let run = 1;
  const server = await startFakeOpenRouter("success", {
    chatContent: (prompt) => {
      if (run === 1) return JSON.stringify({ findings: [FINDING_A] });
      // The same guide, so carry-over applies: the model restates nothing and
      // the previous finding must be carried forward as "open".
      if (!/PREVIOUS FINDINGS/i.test(prompt)) {
        throw new Error("carry-over block missing from the second prompt");
      }
      if (!/Scan the DIFF from scratch/i.test(prompt)) {
        throw new Error("the prompt no longer asks for a fresh scan");
      }
      return JSON.stringify({
        findings: [],
        previousFindings: [{ id: "F1", state: "open" }],
      });
    },
  });
  try {
    const { worktree, configPath, reposDir, repo } =
      await prepareWorktree(root);
    await runReview(root, worktree, repo, configPath, reposDir, server.url);
    run = 2;
    const second = await runReview(
      root,
      worktree,
      repo,
      configPath,
      reposDir,
      server.url,
    );
    if (!openAt(second.stdout, "src/a.ts")) {
      throw new Error(
        `the previous finding was not carried:\n${second.stdout}${second.stderr}`,
      );
    }
  } finally {
    await server.close();
    await removePath(root, { recursive: true });
  }
});
