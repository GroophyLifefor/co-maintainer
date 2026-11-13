/** e2e:simulate: co-maintainer's features run in a simulated world.
 *
 *   npm run e2e:simulate
 *   npm run e2e:simulate -- --flow=init
 *   npm run e2e:simulate -- --ai=openrouter --ai-key=... --low-model=... --high-model=...
 *
 * No GitHub repository, no GitHub App, no server process: everything runs in
 * this process. GitHub lives in memory over real git repositories in a
 * sandbox, `fetch` and `gh` are caught so nothing leaves the machine, and the
 * product's own functions are called directly. Without `--ai` each flow's
 * fake AI script answers; with it the real provider does, and costs money.
 *
 * Each flow is a file under `src/testing/sim/flows/`. This script only parses
 * the flags and runs the registered flows, each in its own world.
 * Deterministic checks fail the run. Scores are only reported. Each step is
 * one terminal line; `--output=<dir>` also writes a JSON file per run with the
 * summary and, per flow, the full trace (GitHub, AI and remote calls, webhook
 * deliveries, GitHub writes, logs, git commands, files and database rows). */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FlowResult, runFlow } from "../src/testing/sim/flow.ts";
import { FLOWS } from "../src/testing/sim/flows/index.ts";
import {
  printCheck,
  printScore,
  printStep,
  writeReport,
} from "../src/testing/sim/report.ts";

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

  --flow=<name>         run only this flow, repeat or comma separate for more
  --ai=<provider>       run with a real AI: ${PROVIDERS.join(", ")}
  --ai-key=<key>        that provider's key
  --low-model=<id>      the low model
  --high-model=<id>     the high model
  --judge-ai=<provider> the LLM judge's provider
  --judge-key=<key>     the judge's key
  --judge-model=<id>    the judge's model
  --output=<dir>        write a JSON report of the run into this directory
  --keep                keep each flow's sandbox directory after the run

Flows: ${FLOWS.map((flow) => flow.name).join(", ")}

Without --flow every flow runs. Without --ai the fake AI answers. The four
--ai flags go together, and so do the three --judge flags.`;

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

function parseFlags(args: string[]): {
  flags: Flags;
  flows: string[];
  keep: boolean;
} {
  const flags: Record<string, string> = {};
  const flows: string[] = [];
  let keep = false;
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--keep") {
      keep = true;
      continue;
    }
    const at = arg.indexOf("=");
    const name = at > 0 ? arg.slice(0, at) : arg;
    if (name === "--flow" && at > 0 && at < arg.length - 1) {
      flows.push(
        ...arg
          .slice(at + 1)
          .split(",")
          .filter(Boolean),
      );
      continue;
    }
    const key = FLAG_NAMES[name];
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
  const known = new Set(FLOWS.map((flow) => flow.name));
  const unknown = flows.filter((name) => !known.has(name));
  if (unknown.length) usageError(`Unknown flow: ${unknown.join(", ")}`);
  return { flags: flags as Flags, flows, keep };
}

const { flags, flows: chosen, keep } = parseFlags(process.argv.slice(2));
const mode = flags.ai ? "live" : "fake";
const version = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string;
  }
).version;
// Read before any world sets GIT_TRACE2_EVENT, so it stays out of the trace.
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT })
  .stdout.toString()
  .trim();

const started = performance.now();
const startedAt = new Date().toISOString();
const flows = chosen.length
  ? FLOWS.filter((flow) => chosen.includes(flow.name))
  : FLOWS;
const settings = {
  mode,
  provider: flags.ai ?? "openrouter",
  aiKey: flags.aiKey,
  lowModel: flags.lowModel ?? "simulate/low",
  highModel: flags.highModel ?? "simulate/high",
  judge: flags.judgeAi
    ? {
        provider: flags.judgeAi,
        key: flags.judgeKey ?? "",
        model: flags.judgeModel ?? "",
      }
    : undefined,
  origin: started,
} as const;

const results: FlowResult[] = [];
for (const flow of flows) {
  results.push(
    await runFlow(
      flow,
      settings,
      { step: printStep, check: printCheck, score: printScore },
      keep,
    ),
  );
}
const failed = results.some((result) => !result.passed);

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
      provider: settings.provider,
      lowModel: settings.lowModel,
      highModel: settings.highModel,
    },
    judge: flags.judgeAi
      ? { provider: flags.judgeAi, model: flags.judgeModel }
      : null,
    flows: results,
  };
  let text = JSON.stringify(report);
  for (const secret of [flags.aiKey, flags.judgeKey]) {
    if (secret) text = text.replaceAll(secret, "[redacted]");
  }
  const path = writeReport(flags.output, commit, JSON.parse(text));
  console.log(`report ${path}`);
}

console.log(
  `e2e:simulate ${failed ? "failed" : "ok"} · ${results.length} flow${results.length === 1 ? "" : "s"} · ${((performance.now() - started) / 1000).toFixed(2)}s`,
);
process.exitCode = failed ? 1 : 0;
