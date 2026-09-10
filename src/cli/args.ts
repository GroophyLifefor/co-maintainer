import type { Options } from "../types.ts";
import { prepareConfig } from "../config.ts";

function die(message: string): never {
  throw new Error(message);
}

function numberOption(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    die(`${name} must be a non-negative integer`);
  }
  return number;
}

const commands = ["probe", "init", "remake", "review"] as const;
const defaultLowModel = "openai/gpt-oss-120b";
const defaultHighModel = "openai/gpt-5.6-luna";

function ask(
  label: string,
  fallback?: string,
  required = false,
): string {
  if (!Deno.stdin.isTerminal()) {
    die(
      `Missing ${label}; pass it as a CLI option when running without an interactive terminal`,
    );
  }
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = prompt(`${label}${suffix}:`)?.trim() ?? "";
  const value = answer || fallback || "";
  if (required && !value) die(`${label} is required`);
  return value;
}

export function parseArgs(args: string[]): Options {
  const [command, repo, ...rest] = args;
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    repo === "--help" ||
    repo === "-h"
  ) {
    console.log(
      "Usage: co-maintainer <probe|init|remake|review> owner/repo [options]",
    );
    console.log("       co-maintainer review owner/repo PR_NUMBER [options]");
    console.log(
      "       co-maintainer set --token=... --ai=... --low-model=... --high-model=... --auth=...",
    );
    console.log("       co-maintainer serve --port=N");
    console.log(
      "         --env=PATH --debug --log-time --gh-concurrent=N --ai-concurrent=N --improve-matrix=N",
    );
    console.log(
      "Options: --include-codebase --include-pull-requests --include-pull-request-changes",
    );
    console.log("         --include-commit-history --include-how-repo-works");
    console.log(
      "         --max-commits=N --max-pr-months=N --max-pull-request-change-lines=N --max-comment=N",
    );
    console.log(
      "         --auth=gh|pat --ai=none|openrouter|hetzner --token=... --low-model=... --high-model=...",
    );
    Deno.exit(0);
  }
  if (!commands.includes(command as typeof commands[number])) {
    die(`Unknown command: ${command}`);
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage: co-maintainer ${command} ...`);
    console.log("Run co-maintainer --help for all options.");
    Deno.exit(0);
  }
  if (repo === "--help" || repo === "-h") {
    console.log(`Usage: co-maintainer ${command} ...`);
    console.log("Run co-maintainer --help for all options.");
    Deno.exit(0);
  }
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    die("Repository must look like owner/repo");
  }

  const { config, envPath } = prepareConfig(args);
  const env = (name: string): string | undefined => Deno.env.get(name);
  const configDefault = config.defaults ?? {};
  // Remembered from a prior `init`/`remake` on this exact repo — never a
  // secret, so it can safely fill in everything except the API token.
  const repoConfig = config.repos?.[repo] ?? {};

  let prNumber: number | undefined;
  if (command === "review") {
    const rawNumber = rest.shift();
    if (!rawNumber || !/^\d+$/.test(rawNumber)) {
      die("review requires a numeric PR number");
    }
    prNumber = Number(rawNumber);
  }

  const includeNames = [
    "include-codebase",
    "include-pull-requests",
    "include-pull-request-changes",
    "include-commit-history",
    "include-how-repo-works",
  ];
  const explicitlyIncluded = rest.some((arg) =>
    includeNames.some((name) => arg === `--${name}`)
  );
  const includeKeys = {
    "include-codebase": "includeCodebase",
    "include-pull-requests": "includePullRequests",
    "include-pull-request-changes": "includePullRequestChanges",
    "include-commit-history": "includeCommitHistory",
    "include-how-repo-works": "includeHowRepoWorks",
  } as const;
  const enabled = (name: keyof typeof includeKeys) =>
    explicitlyIncluded
      ? rest.includes(`--${name}`)
      : repoConfig[includeKeys[name]] ?? true;
  const value = (name: string): number | undefined => {
    const arg = rest.find((item) => item.startsWith(`--${name}=`));
    return arg
      ? numberOption(arg.slice(name.length + 3), `--${name}`)
      : undefined;
  };
  const text = (name: string): string | undefined =>
    rest.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  const choice = <T extends string>(
    name: string,
    allowed: T[],
    fallback: T,
  ): T => {
    const prefix = `--${name}=`;
    const raw = rest.find((arg) => arg.startsWith(prefix))?.slice(
      prefix.length,
    );
    if (!raw) return fallback;
    if (!allowed.includes(raw as T)) {
      die(`${name} must be one of: ${allowed.join(", ")}`);
    }
    return raw as T;
  };

  for (const arg of rest) {
    const known = includeNames.some((name) => arg === `--${name}`) ||
      [
        "max-commits",
        "max-pr-months",
        "max-pull-request-change-lines",
        "max-comment",
        "improve-matrix",
        "env",
        "gh-concurrent",
        "ai-concurrent",
        "auth",
        "ai",
        "token",
        "low-model",
        "high-model",
      ]
        .some((name) => arg.startsWith(`--${name}=`));
    if (arg === "--debug" || arg === "--log-time") continue;
    if (arg.startsWith("--") && !known) die(`Unknown option: ${arg}`);
  }

  const explicitAi = rest.some((arg) => arg.startsWith("--ai="));
  const configuredAiRaw = env("CO_MAINTAINER_AI") ?? repoConfig.ai ??
    config.ai;
  if (
    configuredAiRaw &&
    !["none", "openrouter", "hetzner"].includes(configuredAiRaw)
  ) {
    die("CO_MAINTAINER_AI/config.ai must be none, openrouter, or hetzner");
  }
  const configuredAi = configuredAiRaw as Options["ai"] | undefined;
  const configuredAuthRaw = env("CO_MAINTAINER_AUTH") ?? repoConfig.auth ??
    config.auth;
  if (configuredAuthRaw && !["gh", "pat"].includes(configuredAuthRaw)) {
    die("CO_MAINTAINER_AUTH/config.auth must be gh or pat");
  }
  const configuredAuth = configuredAuthRaw as Options["auth"] | undefined;
  let ai = choice(
    "ai",
    ["none", "openrouter", "hetzner"],
    configuredAi ?? "none",
  );
  if (command === "review") {
    if (
      explicitAi &&
      choice("ai", ["none", "openrouter", "hetzner"], "none") !== "openrouter"
    ) {
      die("review supports OpenRouter only");
    }
    ai = "openrouter";
  } else if (
    !explicitAi &&
    !configuredAi &&
    command !== "probe"
  ) {
    const selected = ask(
      "AI provider (openrouter|hetzner)",
      "openrouter",
    );
    if (!["openrouter", "hetzner"].includes(selected)) {
      die("AI provider must be openrouter or hetzner");
    }
    ai = selected as Options["ai"];
  }
  let aiToken = text("token") ??
    env("CO_MAINTAINER_TOKEN") ??
    (ai === "openrouter" ? env("OPENROUTER_API_KEY") : undefined) ??
    (ai === "hetzner" ? env("HETZNER_API_KEY") : undefined) ??
    config.token;
  let lowModel = text("low-model") ??
    env("OPENROUTER_LOW_MODEL") ??
    env("HETZNER_LOW_MODEL") ??
    env("LOW_MODEL") ??
    repoConfig.lowModel ??
    config.lowModel;
  let highModel = text("high-model") ??
    env("OPENROUTER_HIGH_MODEL") ??
    env("HETZNER_HIGH_MODEL") ??
    env("HIGH_MODEL") ??
    repoConfig.highModel ??
    config.highModel;
  if (command === "review") {
    aiToken ??= ask("openrouter API key", undefined, true);
    highModel ??= ask("high model", defaultHighModel, true);
  } else if (ai !== "none" && command !== "probe") {
    aiToken ??= ask(`${ai} API key`, undefined, true);
    lowModel ??= ask("low model", defaultLowModel, true);
    highModel ??= ask("high model", defaultHighModel, true);
  }
  if (
    command !== "review" &&
    ai !== "none" &&
    (!lowModel || !highModel || !aiToken)
  ) {
    die(
      "--token, --low-model, and --high-model are required when AI is enabled",
    );
  }

  return {
    command: command as Options["command"],
    repo,
    prNumber,
    debug: rest.includes("--debug"),
    logTime: rest.includes("--log-time"),
    envPath,
    improveMatrix: value("improve-matrix") ?? 1,
    ghConcurrent: Math.max(1, value("gh-concurrent") ?? 1),
    aiConcurrent: Math.max(1, value("ai-concurrent") ?? 3),
    auth: choice("auth", ["gh", "pat"], configuredAuth ?? "gh"),
    ai,
    aiToken,
    lowModel,
    highModel,
    synthesisVersion: 16,
    includeCodebase: enabled("include-codebase"),
    includePullRequests: enabled("include-pull-requests"),
    includePullRequestChanges: enabled("include-pull-request-changes"),
    includeCommitHistory: enabled("include-commit-history"),
    includeHowRepoWorks: enabled("include-how-repo-works"),
    maxCommits: value("max-commits") ?? repoConfig.maxCommits ??
      configDefault.maxCommits,
    maxPrMonths: value("max-pr-months") ?? repoConfig.maxPrMonths ??
      configDefault.maxPrMonths,
    maxPullRequestChangeLines: value("max-pull-request-change-lines") ??
      repoConfig.maxPullRequestChangeLines ??
      configDefault.maxPullRequestChangeLines,
    maxComments: value("max-comment") ?? repoConfig.maxComments,
  };
}
