/** e2e:simulate: co-maintainer's features run in a simulated world.
 *
 *   npm run e2e:simulate
 *   npm run e2e:simulate -- --ai=openrouter --ai-key=... --low-model=... --high-model=...
 *
 * No GitHub repository, no GitHub App, no server process: everything runs in
 * this process. GitHub lives in memory over real git repositories in a
 * sandbox, `fetch` is caught so nothing leaves the machine, and the product's
 * own functions are called directly. Without `--ai` a fake AI answers; with it
 * the real provider does, and costs money.
 *
 * Deterministic checks fail the run. Scores are only reported. Each step is
 * one terminal line; `--output=<dir>` also writes a JSON file per run with the
 * summary and the full trace (GitHub and AI calls, logs, git commands, files
 * and database rows).
 *
 * This first version covers `init`, codebase only. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "../src/types.ts";
import {
  initChecks,
  initScores,
  type InitContext,
} from "../src/testing/sim/checks/init.ts";
import { installFetch } from "../src/testing/sim/fetch.ts";
import {
  printCheck,
  printScore,
  printStep,
  writeReport,
  type StepResult,
} from "../src/testing/sim/report.ts";
import {
  SAMPLE_REPO,
  SAMPLE_REPO_NAME,
} from "../src/testing/sim/sample_repo.ts";
import {
  dumpDatabase,
  readFiles,
  readGitTrace,
  Trace,
} from "../src/testing/sim/trace.ts";
import { createWorld } from "../src/testing/sim/world.ts";

const ROOT = join(import.meta.dirname, "..");
const PROVIDERS = [
  "openrouter",
  "openai",
  "anthropic",
  "opencode-zen",
  "opencode-go",
] as const;
type Provider = (typeof PROVIDERS)[number];

const USAGE = `Usage: npm run e2e:simulate -- [options]

  --ai=<provider>       run with a real AI: ${PROVIDERS.join(", ")}
  --ai-key=<key>        that provider's key
  --low-model=<id>      the low model
  --high-model=<id>     the high model
  --judge-ai=<provider> the LLM judge's provider
  --judge-key=<key>     the judge's key
  --judge-model=<id>    the judge's model
  --output=<dir>        write a JSON report of the run into this directory

Without --ai the fake AI answers. The four --ai flags go together, and so do
the three --judge flags.`;

type Flags = {
  ai?: Provider;
  aiKey?: string;
  lowModel?: string;
  highModel?: string;
  judgeAi?: Provider;
  judgeKey?: string;
  judgeModel?: string;
  output?: string;
};

const FLAG_NAMES: Record<string, keyof Flags> = {
  "--ai": "ai",
  "--ai-key": "aiKey",
  "--low-model": "lowModel",
  "--high-model": "highModel",
  "--judge-ai": "judgeAi",
  "--judge-key": "judgeKey",
  "--judge-model": "judgeModel",
  "--output": "output",
};

function usageError(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseFlags(args: string[]): Flags {
  const flags: Record<string, string> = {};
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    const at = arg.indexOf("=");
    const key = FLAG_NAMES[at > 0 ? arg.slice(0, at) : arg];
    if (!key || at < 0 || at === arg.length - 1) {
      usageError(`Unknown or empty flag: ${arg}`);
    }
    flags[key] = arg.slice(at + 1);
  }
  for (const key of ["ai", "judgeAi"]) {
    if (flags[key] && !PROVIDERS.includes(flags[key] as Provider)) {
      usageError(`Unknown provider: ${flags[key]}`);
    }
  }
  const groups: [string, (keyof Flags)[]][] = [
    ["--ai", ["ai", "aiKey", "lowModel", "highModel"]],
    ["--judge", ["judgeAi", "judgeKey", "judgeModel"]],
  ];
  for (const [label, keys] of groups) {
    const given = keys.filter((key) => flags[key]);
    if (given.length && given.length < keys.length) {
      usageError(`The ${label} flags go together, and one of them is missing.`);
    }
  }
  return flags as Flags;
}

const flags = parseFlags(process.argv.slice(2));
const mode = flags.ai ? "live" : "fake";
const version = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string;
  }
).version;
// Read before the world sets GIT_TRACE2_EVENT, so it stays out of the trace.
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT })
  .stdout.toString()
  .trim();

const options: Options = {
  command: "init",
  repo: SAMPLE_REPO_NAME,
  debug: false,
  logTime: false,
  improveMatrix: 1,
  ghConcurrent: 4,
  aiConcurrent: 3,
  auth: "pat",
  githubPat: "simulate-token",
  // The fake AI answers OpenRouter's protocol through the caught fetch.
  ai: flags.ai ?? "openrouter",
  aiToken: flags.aiKey ?? "simulate-key",
  lowModel: flags.lowModel ?? "simulate/low",
  highModel: flags.highModel ?? "simulate/high",
  synthesisVersion: 17,
  includeCodebase: true,
  includePullRequests: false,
  includePullRequestChanges: false,
  includeCommitHistory: false,
  includeHowRepoWorks: false,
  onlyRequestChangedPr: false,
  maxPrMonths: 12,
};

const started = performance.now();
const startedAt = new Date().toISOString();
const steps: StepResult[] = [];
let failed = false;

function finishStep(name: string, from: number, ok: boolean, detail: string) {
  const step = {
    name,
    ok,
    startMs: Math.round(from - started),
    ms: performance.now() - from,
    detail,
  };
  steps.push(step);
  printStep(step);
  if (!ok) failed = true;
}

let at = performance.now();
const world = createWorld();
const trace = new Trace(started);
const restoreFetch = installFetch({ world, trace, ai: mode });
finishStep("sandbox ready", at, true, world.root);

try {
  at = performance.now();
  const repo = world.createRepo(SAMPLE_REPO_NAME, SAMPLE_REPO);
  finishStep(
    "repo opened",
    at,
    true,
    `${repo.fullName} · ${Object.keys(SAMPLE_REPO).length} files`,
  );

  // Product modules load only now, after the world has set the env.
  const { runInitOrRemake } = await import("../src/services/setup.ts");
  const { withLogSink } = await import("../src/util/log.ts");
  const { cacheDbPath, reposDir } = await import("../src/config.ts");
  const { appDbPath } = await import("../src/store/app_db.ts");

  at = performance.now();
  trace.step = "init";
  let error: unknown;
  try {
    await withLogSink(
      (phase, message) => trace.log(phase, message),
      () => runInitOrRemake({ ...options }),
    );
  } catch (caught) {
    error = caught;
  }
  const initCalls = (list: { step: string }[]) =>
    list.filter((call) => call.step === "init").length;
  finishStep(
    "init",
    at,
    error === undefined,
    `${mode} AI · ${initCalls(trace.ai)} AI calls · ${initCalls(trace.github)} GitHub calls`,
  );

  const context: InitContext = {
    repo: SAMPLE_REPO_NAME,
    reposDir: reposDir(),
    appDbPath: appDbPath(),
    cacheDbPath: cacheDbPath(),
    error,
    trace,
    ai: mode,
    files: SAMPLE_REPO,
    judge: flags.judgeAi
      ? {
          options: { ...options, ai: flags.judgeAi, aiToken: flags.judgeKey },
          model: flags.judgeModel ?? "",
        }
      : undefined,
  };
  const checks = initChecks(context);
  for (const check of checks) {
    printCheck(check);
    if (!check.ok) failed = true;
  }
  // Its own step, so the judge's time shows apart from init's.
  at = performance.now();
  trace.step = "judge";
  const scores = await initScores(context);
  const judged = scores.find((score) => score.name.includes("LLM judge"));
  finishStep(
    "judge",
    at,
    true,
    judged?.skipped ? `skipped · ${judged.skipped}` : (judged?.detail ?? ""),
  );
  for (const score of scores) printScore(score);

  if (flags.output) {
    const report = {
      tool: "e2e:simulate",
      version,
      commit,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      passed: !failed,
      ai: {
        mode,
        provider: options.ai,
        lowModel: options.lowModel,
        highModel: options.highModel,
      },
      judge: flags.judgeAi
        ? { provider: flags.judgeAi, model: flags.judgeModel }
        : null,
      steps,
      checks,
      scores,
      trace: {
        github: trace.github,
        ai: trace.ai,
        leaks: trace.leaks,
        logs: trace.logs,
        git: readGitTrace(world.gitTracePath, Date.parse(startedAt)),
        files: readFiles(reposDir()),
        databases: {
          app: dumpDatabase(appDbPath()),
          cache: dumpDatabase(cacheDbPath()),
        },
      },
    };
    let text = JSON.stringify(report);
    for (const secret of [flags.aiKey, flags.judgeKey]) {
      if (secret) text = text.replaceAll(secret, "[redacted]");
    }
    const path = writeReport(flags.output, commit, JSON.parse(text));
    console.log(`report ${path}`);
  }
} finally {
  restoreFetch();
  world.dispose();
}

console.log(
  `e2e:simulate ${failed ? "failed" : "ok"} · ${((performance.now() - started) / 1000).toFixed(2)}s`,
);
process.exitCode = failed ? 1 : 0;
