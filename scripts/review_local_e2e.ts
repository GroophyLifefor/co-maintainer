/** Plan §25.2 — local review with fake AI and a real git worktree. */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandOutput,
  envToObject,
  makeTempDir,
  mkdir,
  remove,
  writeTextFile,
} from "../src/util/runtime.ts";

/** `deno run --allow-all <script>` or plain `node <script>`, depending on
 * which runtime is executing this file. */
function runtimeRunArgs(script: string, args: string[]): string[] {
  const isDeno = typeof (globalThis as { Deno?: unknown }).Deno !== "undefined";
  return isDeno ? ["run", "--allow-all", script, ...args] : [script, ...args];
}

const REPO = "e2e-local/review-loop";
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await commandOutput("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
}

async function reviewJson(
  worktree: string,
  env: Record<string, string>,
  args: string[],
): Promise<Record<string, unknown>> {
  const result = await commandOutput(process.execPath, {
    args: [...runtimeRunArgs("main.ts", ["review", "--json", ...args])],
    cwd: projectRoot,
    env: { ...envToObject(), ...env, PWD: worktree },
    stdout: "piped",
    stderr: "piped",
  });
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`review exit ${result.code}: ${stderr}`);
  }
  const stdout = new TextDecoder().decode(result.stdout).trim();
  if (!stdout) throw new Error(`empty stdout: ${stderr}`);
  return JSON.parse(stdout) as Record<string, unknown>;
}

const tmp = await makeTempDir({ prefix: "cm-local-e2e-" });
const configPath = `${tmp}/config.json`;
const reposDir = `${tmp}/repos`;
const appDb = `${tmp}/app.db`;
const repoDir = `${reposDir}/${REPO}`;
const worktree = `${tmp}/worktree`;
const fakeFile = `${tmp}/fake.md`;

await mkdir(repoDir, { recursive: true });
await writeTextFile(
  `${repoDir}/PR_REVIEW_GUIDE.md`,
  "# Guide\n\nCheck eval usage.\n",
);
await writeTextFile(
  configPath,
  JSON.stringify({
    auth: "gh",
    ai: "openrouter",
    token: "fake",
    highModel: "fake/model",
  }),
);
await mkdir(worktree, { recursive: true });
await git(worktree, ["init"]);
await git(worktree, ["config", "user.email", "e2e@test"]);
await git(worktree, ["config", "user.name", "e2e"]);
await writeTextFile(`${worktree}/app.ts`, "export const v = 1;\n");
await git(worktree, ["add", "app.ts"]);
await git(worktree, ["commit", "-m", "init"]);
await git(worktree, ["branch", "-M", "main"]);
await git(worktree, [
  "remote",
  "add",
  "origin",
  `https://github.com/${REPO}.git`,
]);
await git(worktree, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
await writeTextFile(`${worktree}/app.ts`, "export const v = 2;\n");
await git(worktree, ["add", "app.ts"]);
await git(worktree, ["commit", "-m", "change"]);

const twoFindingsMarkdown = `## Findings

### [P2 · non-blocking] \`app.ts\` — \`v\`
Location: \`app.ts:1\`

First issue.

### [P2 · non-blocking] \`app.ts\` — \`other\`
Location: \`app.ts:1\`

Second issue.
`;
await writeTextFile(fakeFile, twoFindingsMarkdown);

const baseEnv = {
  CM_CONFIG_PATH: configPath,
  CM_REPOS_DIR: reposDir,
  CM_APP_DB: appDb,
  CM_FAKE_AI: "1",
  CM_FAKE_REVIEW_FILE: fakeFile,
};

const prev = process.cwd();
process.chdir(worktree);
try {
  const round1 = await reviewJson(worktree, baseEnv, [
    `--repo=${REPO}`,
    "--disable-codegraph",
    "--token=fake",
    "--high-model=fake/model",
  ]);
  if (round1.ok !== true) {
    throw new Error(`round1: ${JSON.stringify(round1)}`);
  }
  const findings = round1.findings as unknown[] | undefined;
  if (!findings || findings.length < 2) {
    throw new Error(`round1 expected 2 findings, got ${findings?.length}`);
  }

  await writeTextFile(
    fakeFile,
    `## Previous findings

- F1: closed
- F2: open

## Findings

No new issues.
`,
  );
  const roundCarry = await reviewJson(worktree, baseEnv, [
    `--repo=${REPO}`,
    "--disable-codegraph",
    "--token=fake",
    "--high-model=fake/model",
  ]);
  if (roundCarry.ok !== true) {
    throw new Error(`round carry: ${JSON.stringify(roundCarry)}`);
  }
  const carryFindings = roundCarry.findings as
    | Array<{ state: string }>
    | undefined;
  if (!carryFindings || carryFindings.length < 2) {
    throw new Error(`carry findings: ${carryFindings?.length}`);
  }
  if (!carryFindings.some((row) => row.state === "closed")) {
    throw new Error(`carry states: ${JSON.stringify(carryFindings)}`);
  }

  await writeTextFile(fakeFile, twoFindingsMarkdown);

  const round2 = await reviewJson(worktree, baseEnv, [
    `--repo=${REPO}`,
    "--fresh",
    "--disable-codegraph",
    "--token=fake",
    "--high-model=fake/model",
  ]);
  if (round2.ok !== true) {
    throw new Error(`round2 fresh: ${JSON.stringify(round2)}`);
  }
} finally {
  process.chdir(prev);
}

console.log("review_local_e2e: ok");
await remove(tmp, { recursive: true });
