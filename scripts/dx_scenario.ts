/** Live end-to-end DX scenario (CORE-06).
 *
 * Replays the DX research journey against a real `gh` and a real OpenRouter
 * key, on `GroophyLifefor/cm-dx-lab`. Not run in CI: it spends money and
 * touches GitHub. The key is read from `OPENROUTER_API_KEY` and passed to the
 * child only through its environment, it is never written to a file, a commit
 * or the report.
 *
 *   OPENROUTER_API_KEY=... npm run dx:scenario
 *   OPENROUTER_API_KEY=... DX_MAIN=<path to dist/main.js> DX_LABEL=0.4.13 \
 *     npm run dx:scenario
 *
 * Point `DX_MAIN` at the installed 0.4.13 `dist/main.js` to reproduce the
 * research report's known findings, which the run has to show as failures.
 * That is the proof the scenario measures the right thing.
 *
 * Steps whose fix belongs to a later task (per-command help CORE-20, `view`
 * CORE-23, `config` CORE-22, `sync` CORE-21) are recorded as skipped with the
 * owning task, so the run stays useful before those land.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandOutput,
  commandSpawn,
  envToObject,
  makeTempDir,
  mkdir,
  readFile,
  remove,
  writeTextFile,
} from "../src/util/runtime.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const REPO = process.env.DX_REPO ?? "GroophyLifefor/cm-dx-lab";
const PR_NUMBER = Number(process.env.DX_PR ?? "4");
const label = process.env.DX_LABEL ?? "branch";
const mainEntry = process.env.DX_MAIN ?? join(projectRoot, "main.ts");
const budgetUsd = Number(process.env.DX_BUDGET_USD ?? "0.10");
const outPath = process.env.DX_OUT;
const only = process.env.DX_ONLY
  ? new Set(process.env.DX_ONLY.split(",").map((item) => item.trim()))
  : null;

const apiKey =
  process.env.OPENROUTER_API_KEY ?? process.env.CO_MAINTAINER_TOKEN;
if (!apiKey) {
  throw new Error(
    "OPENROUTER_API_KEY is required. The scenario never reads it from a file.",
  );
}
if (process.env.CM_FAKE_AI === "1") {
  throw new Error("dx_scenario refuses CM_FAKE_AI=1, use a real provider.");
}

const lowModel = process.env.DX_LOW_MODEL ?? "openai/gpt-oss-120b";
const highModel = process.env.DX_HIGH_MODEL ?? "openai/gpt-5.6-luna";

type Row = {
  step: string;
  status: "pass" | "fail" | "skip" | "info";
  ms: number;
  costUsd: number | null;
  detail: string;
  note?: string;
};
const rows: Row[] = [];

function record(row: Row): void {
  rows.push(row);
  const cost = row.costUsd === null ? "" : ` $${row.costUsd.toFixed(4)}`;
  console.log(
    `${row.status.padEnd(4)} ${row.step} · ${row.ms}ms${cost} · ${row.detail}`,
  );
  if (row.note) console.log(`     ${row.note}`);
}

async function usageUsd(): Promise<number> {
  const response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = (await response.json()) as {
    data?: { usage?: number };
    error?: unknown;
  };
  if (!response.ok || body.data?.usage === undefined) {
    throw new Error(
      `OpenRouter key endpoint failed (${response.status}): ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return body.data.usage;
}

const startedUsage = await usageUsd();
let spent = 0;
let budgetHit = false;

/** Queries usage and enforces the run budget. Returns the step's own cost. */
async function settle(costBefore: number): Promise<number | null> {
  const now = await usageUsd();
  const delta = now - costBefore;
  spent = now - startedUsage;
  if (spent > budgetUsd) {
    budgetHit = true;
    console.log(
      `budget exceeded · spent $${spent.toFixed(4)} of $${budgetUsd.toFixed(2)} · stopping AI steps`,
    );
  }
  return delta;
}

type CliRun = {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
};

const sandbox = await makeTempDir({ prefix: "cm-dx-scenario-" });
const configDir = join(sandbox, "config");
const reposDir = join(sandbox, "repos");
const cacheDir = join(sandbox, "cache");
const clonesDir = join(sandbox, "clones");
const worktree = join(sandbox, "worktree");

const childEnv: Record<string, string | undefined> = {
  ...envToObject(),
  CM_CONFIG_PATH: join(configDir, "config.json"),
  CM_REPOS_DIR: reposDir,
  CM_CLONES_DIR: clonesDir,
  XDG_CACHE_HOME: cacheDir,
  XDG_DATA_HOME: join(sandbox, "data"),
  XDG_CONFIG_HOME: configDir,
  APPDATA: join(sandbox, "appdata"),
  LOCALAPPDATA: join(sandbox, "localappdata"),
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.longpaths",
  GIT_CONFIG_VALUE_0: "true",
  OPENROUTER_API_KEY: apiKey,
  // A fake provider would make every AI step meaningless here.
  CM_FAKE_AI: undefined,
};

async function cli(
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CliRun> {
  const started = Date.now();
  const child = commandSpawn(process.execPath, {
    args: [mainEntry, ...args],
    cwd: options.cwd ?? projectRoot,
    env: childEnv,
    stdout: "piped",
    stderr: "piped",
  });
  const output = child.output();
  const timeoutMs = options.timeoutMs;
  // A hung child must not hang the whole run: kill it and report 124, the
  // same convention the CLI harness uses. The timer is cleared when the child
  // wins, otherwise it stays pending and holds the event loop open.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result =
    timeoutMs === undefined
      ? await output
      : await Promise.race([
          output.then((value) => {
            if (timer !== undefined) clearTimeout(timer);
            return value;
          }),
          new Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>(
            (resolve) => {
              timer = setTimeout(() => {
                child.kill("SIGKILL");
                resolve({
                  code: 124,
                  stdout: new Uint8Array(),
                  stderr: new TextEncoder().encode("timed out by scenario"),
                });
              }, timeoutMs);
            },
          ),
        ]);
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    ms: Date.now() - started,
  };
}

// The API key is passed only through `OPENROUTER_API_KEY` in the child's
// environment. It must never appear in argv, where any process on the machine
// can read it from the process list.
const configFlags = [
  `--low-model=${lowModel}`,
  `--high-model=${highModel}`,
  "--auth=gh",
  "--ai=openrouter",
];

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)[0] ?? ""
  );
}

function shouldRun(step: string): boolean {
  return only === null || only.has(step);
}

await mkdir(configDir, { recursive: true });
await mkdir(reposDir, { recursive: true });

// ------------------------------------------------------------- probe

let recommended: string[] | null = null;
if (shouldRun("probe")) {
  const run = await cli(["probe", REPO, "--log-time"]);
  const match = run.stdout.match(/recommended\s*\n\s*(co-maintainer[^\n]+)/);
  if (match) {
    recommended = match[1]
      .trim()
      .split(/\s+/)
      .slice(1) // drop the "co-maintainer" token
      .filter((token) => !token.startsWith("--token"));
  }
  record({
    step: "probe",
    status: run.code === 0 && recommended ? "pass" : "fail",
    ms: run.ms,
    costUsd: null,
    detail:
      run.code === 0
        ? recommended
          ? `recommended: ${recommended.join(" ")}`
          : "exit 0 but no recommended command parsed"
        : `exit ${run.code}: ${firstLine(run.stderr)}`,
  });
}

// ------------------------------------------------------------- init

if (shouldRun("init") && !budgetHit) {
  const costBefore = await usageUsd();
  // The probe line is `co-maintainer init owner/repo <flags>`; drop the two
  // leading tokens so the flags can be appended to our own `init REPO`.
  const recommendedFlags = (recommended ?? []).filter(
    (token) => token !== "init" && token !== REPO,
  );
  const flags =
    recommendedFlags.length > 0
      ? recommendedFlags
      : [
          "--include-codebase",
          "--include-pull-requests",
          "--include-how-repo-works",
        ];
  const run = await cli(["init", REPO, ...flags, ...configFlags, "--log-time"]);
  const cost = await settle(costBefore);
  record({
    step: "init",
    status: run.code === 0 ? "pass" : "fail",
    ms: run.ms,
    costUsd: cost,
    detail:
      run.code === 0
        ? `guides written under ${reposDir}`
        : `exit ${run.code}: ${firstLine(run.stderr)}`,
  });
}

/** Local review refuses to run without a review guide, so with `DX_ONLY`
 * selecting only `local-review` the step has to check for the guides rather
 * than trust an `init` that was filtered out. */
async function guidesExist(): Promise<boolean> {
  for (const name of ["PR_REVIEW_GUIDE.md", "SKILL.md"]) {
    try {
      await readFile(`${reposDir}/${REPO}/${name}`);
      return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

// ------------------------------------------------------------- view (CORE-23)

if (shouldRun("view")) {
  const run = await cli(["view", REPO]);
  // Only the current CLI's own wording for an unimplemented command counts as
  // "not yet". Any other failure is a real result to look at.
  const notYet = /Unknown command/.test(run.stderr);
  record({
    step: "view",
    status: notYet ? "skip" : "info",
    ms: run.ms,
    costUsd: null,
    detail: notYet
      ? "command not present yet"
      : `exit ${run.code}: ${firstLine(run.stdout || run.stderr).slice(0, 80)}`,
    note: "owned by CORE-23",
  });
}

// ------------------------------------------------------------- review a PR

if (shouldRun("review-pr") && !budgetHit) {
  const costBefore = await usageUsd();
  const run = await cli([
    "review",
    REPO,
    String(PR_NUMBER),
    "--json",
    ...configFlags,
  ]);
  const cost = await settle(costBefore);
  let detail = `exit ${run.code}`;
  let status: Row["status"] = "info";
  try {
    const parsed = JSON.parse(run.stdout.trim()) as {
      ok?: boolean;
      findings?: Array<{ title?: string; body?: string }>;
      usage?: { costUsd?: number | null };
    };
    const findings = parsed.findings ?? [];
    const longest = Math.max(0, ...findings.map((f) => (f.body ?? "").length));
    detail = `exit ${run.code} · ok=${parsed.ok} · findings=${findings.length} · longest body=${longest}`;
    status = run.code === 0 || run.code === 1 ? "pass" : "fail";
  } catch {
    status = "fail";
    detail = `exit ${run.code} · stdout was not JSON · ${firstLine(run.stderr).slice(0, 100)}`;
  }
  record({
    step: "review-pr",
    status,
    ms: run.ms,
    costUsd: cost,
    detail,
  });
}

// ------------------------------------------------------------- local review

if (shouldRun("local-review") && !budgetHit) {
  if (!(await guidesExist())) {
    record({
      step: "local-review",
      status: "skip",
      ms: 0,
      costUsd: null,
      detail: "no review guides under the repos dir, local review would fail",
    });
  } else {
    const costBefore = await usageUsd();
    const git = async (args: string[]): Promise<void> => {
      const result = await commandOutput("git", {
        args,
        cwd: worktree,
        stdout: "piped",
        stderr: "piped",
      });
      if (!result.success) {
        throw new Error(
          `git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`,
        );
      }
    };
    await mkdir(worktree, { recursive: true });
    await mkdir(`${worktree}/src`, { recursive: true });
    await git(["init"]);
    await git(["config", "user.email", "dx@scenario"]);
    await git(["config", "user.name", "dx scenario"]);
    await writeTextFile(`${worktree}/src/index.js`, "module.exports = {};\n");
    await git(["add", "."]);
    await git(["commit", "-m", "base"]);
    await git(["branch", "-M", "main"]);
    await git(["remote", "add", "origin", `https://github.com/${REPO}.git`]);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    // The DX research clone carries this uncommitted fixture with four
    // intentional violations: Math.floor, no export, no CHANGELOG, no test.
    await writeTextFile(
      `${worktree}/src/sum.js`,
      "function sum(list) {\n  return Math.floor(list.reduce((a, b) => a + b, 0));\n}\n",
    );

    const run = await cli(
      [
        "review",
        "--json",
        "--disable-codegraph",
        `--repo=${REPO}`,
        ...configFlags,
      ],
      { cwd: worktree, timeoutMs: 600_000 },
    );
    const cost = await settle(costBefore);
    let detail = `exit ${run.code}`;
    let status: Row["status"] = "info";
    try {
      const parsed = JSON.parse(run.stdout.trim()) as {
        ok?: boolean;
        findings?: Array<{ title?: string; body?: string }>;
      };
      const findings = parsed.findings ?? [];
      detail = `exit ${run.code} · ok=${parsed.ok} · findings=${findings.length}`;
      status = run.code === 0 || run.code === 1 ? "pass" : "fail";
    } catch {
      status = "fail";
      detail = `exit ${run.code} · stdout was not JSON · ${firstLine(run.stderr).slice(0, 100)}`;
    }
    record({
      step: "local-review",
      status,
      ms: run.ms,
      costUsd: cost,
      detail,
    });
  }
}

// ------------------------------------------------------------- sync (CORE-21)

if (shouldRun("sync") && !budgetHit) {
  const costBefore = await usageUsd();
  // `sync` is the visible name once CORE-21 lands, `remake` still works and
  // is what the branch and 0.4.13 expose today.
  const run = await cli(["remake", REPO, ...configFlags, "--log-time"]);
  const cost = await settle(costBefore);
  record({
    step: "sync",
    status: run.code === 0 ? "pass" : "fail",
    ms: run.ms,
    costUsd: cost,
    detail: `exit ${run.code} (via remake)${run.code === 0 ? "" : `: ${firstLine(run.stderr)}`}`,
    note: "`sync` name owned by CORE-21",
  });
}

// ------------------------------------------------------------- config list (CORE-22)

if (shouldRun("config")) {
  const run = await cli(["config", "list"]);
  // Only the current CLI's own wording for an unimplemented command counts as
  // "not yet". Any other failure is a real result to look at.
  const notYet = /Unknown command/.test(run.stderr);
  record({
    step: "config-list",
    status: notYet ? "skip" : "info",
    ms: run.ms,
    costUsd: null,
    detail: notYet
      ? "command not present yet"
      : `exit ${run.code}: ${firstLine(run.stdout).slice(0, 80)}`,
    note: "owned by CORE-22",
  });
}

// ------------------------------------------------------------- help matrix

for (const command of [
  "help",
  "probe",
  "init",
  "remake",
  "review",
  "set",
  "serve",
]) {
  const step = `help:${command}`;
  if (!shouldRun(step)) continue;
  const args = command === "help" ? ["help"] : [command, "--help"];
  const run = await cli(args);
  // CORE-20 makes every help path exit 0. Until then this is information.
  const ok = run.code === 0;
  record({
    step,
    status: ok ? "pass" : "info",
    ms: run.ms,
    costUsd: null,
    detail: `exit ${run.code}: ${firstLine(run.stdout || run.stderr).slice(0, 70)}`,
    note: ok ? undefined : "per-command help exit 0 owned by CORE-20",
  });
}

// ------------------------------------------------------------- error scenarios

type ErrorCase = {
  name: string;
  args: string[];
  cwd?: string;
  /** Exit code the documented contract requires (CORE-10/11). */
  expect: number;
};

const errorCases: ErrorCase[] = [
  { name: "typo-command", args: ["prob", REPO], expect: 2 },
  { name: "typo-flag", args: ["review", "--jsno"], expect: 2 },
  { name: "bad-repo-shape", args: ["review", "not-a-repo"], expect: 2 },
  {
    name: "missing-repo",
    args: ["probe", "GroophyLifefor/does-not-exist-xyz"],
    expect: 2,
  },
  {
    name: "invalid-key",
    args: [
      "review",
      REPO,
      String(PR_NUMBER),
      "--json",
      "--high-model=openai/gpt-5.6-luna",
      "--token=sk-or-v1-invalidscenariokey0000000000000000000000000000000000000000",
    ],
    expect: 2,
  },
  {
    name: "invalid-model",
    args: [
      "review",
      REPO,
      String(PR_NUMBER),
      "--json",
      "--high-model=nope/not-a-real-model",
    ],
    expect: 2,
  },
  {
    name: "not-a-git-repo",
    args: ["review", "--json", "--repo=x/y"],
    cwd: sandbox,
    expect: 2,
  },
];

for (const testCase of errorCases) {
  const step = `error:${testCase.name}`;
  if (!shouldRun(step)) continue;
  if (budgetHit && /invalid-model|invalid-key/.test(testCase.name)) {
    record({
      step,
      status: "skip",
      ms: 0,
      costUsd: null,
      detail: "budget reached",
    });
    continue;
  }
  const run = await cli(testCase.args, { cwd: testCase.cwd });
  const crashed = /Assertion failed|uv_handle|libuv/i.test(run.stderr);
  const detail = `exit ${run.code} (want ${testCase.expect}): ${firstLine(run.stderr || run.stdout).slice(0, 90)}`;
  record({
    step,
    status: run.code === testCase.expect ? "pass" : "fail",
    ms: run.ms,
    costUsd: null,
    detail,
    note: crashed
      ? "Windows libuv assertion crash, this is F08"
      : run.code !== testCase.expect
        ? `exit contract owned by CORE-10, Windows crash by CORE-11`
        : undefined,
  });
}

// ------------------------------------------------------------- report

const failed = rows.filter((row) => row.status === "fail");
const passed = rows.filter((row) => row.status === "pass");
const skipped = rows.filter((row) => row.status === "skip");
const lines: string[] = [];
lines.push(`# DX scenario · ${label}`);
lines.push("");
lines.push(`Repo: \`${REPO}\` · PR #${PR_NUMBER} · entry \`${mainEntry}\``);
lines.push("");
lines.push(
  `Totals: ${passed.length} pass, ${failed.length} fail, ${skipped.length} skip · cost $${spent.toFixed(4)} of $${budgetUsd.toFixed(2)} budget`,
);
lines.push("");
lines.push("| Step | Result | Time | Cost | Detail |");
lines.push("|---|---|---|---|---|");
for (const row of rows) {
  lines.push(
    `| ${row.step} | ${row.status} | ${row.ms}ms | ${
      row.costUsd === null ? "n/a" : `$${row.costUsd.toFixed(4)}`
    } | ${row.detail.replaceAll("|", "\\|")}${row.note ? ` (${row.note})` : ""} |`,
  );
}
lines.push("");
if (budgetHit) lines.push(`Budget of $${budgetUsd.toFixed(2)} was reached.`);
const report = lines.join("\n");
console.log("\n" + report);
if (outPath) await writeTextFile(outPath, report + "\n");

await remove(sandbox, { recursive: true });

// A real failure must not be masked by also having reached the budget, only
// the budget itself is not a failure.
if (failed.length > 0) process.exitCode = 1;
