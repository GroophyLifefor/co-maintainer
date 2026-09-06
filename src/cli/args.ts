import type { Options } from "../types.ts";

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
    command === "--help" ||
    command === "-h" ||
    repo === "--help" ||
    repo === "-h"
  ) {
    console.log(
      "Usage: deno task <probe|init|remake> owner/repo [options]",
    );
    console.log(
      "Options: --include-codebase --include-pull-requests --include-pull-request-changes",
    );
    console.log("         --include-commit-history --include-how-repo-works");
    console.log(
      "         --max-commits=N --max-pr-years=N --max-pull-request-change-lines=N",
    );
    console.log(
      "         --auth=gh|pat --ai=none|openrouter|hetzner --token=... --low-model=... --high-model=...",
    );
    Deno.exit(0);
  }
  if (!["probe", "init", "remake"].includes(command)) {
    die(`Unknown command: ${command}`);
  }
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    die("Repository must look like owner/repo");
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
  const enabled = (name: string) =>
    explicitlyIncluded ? rest.includes(`--${name}`) : true;
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
        "max-pr-years",
        "max-pull-request-change-lines",
        "auth",
        "ai",
        "token",
        "low-model",
        "high-model",
      ]
        .some((name) => arg.startsWith(`--${name}=`));
    if (arg.startsWith("--") && !known) die(`Unknown option: ${arg}`);
  }

  const explicitAi = rest.some((arg) => arg.startsWith("--ai="));
  let ai = choice("ai", ["none", "openrouter", "hetzner"], "none");
  if (!explicitAi && command !== "probe") {
    const selected = ask(
      "AI provider (openrouter|hetzner)",
      "openrouter",
    );
    if (!["openrouter", "hetzner"].includes(selected)) {
      die("AI provider must be openrouter or hetzner");
    }
    ai = selected as Options["ai"];
  }
  let aiToken = text("token");
  let lowModel = text("low-model");
  let highModel = text("high-model");
  if (ai !== "none" && command !== "probe") {
    aiToken ??= ask(`${ai} API key`, undefined, true);
    lowModel ??= ask("low model", defaultLowModel, true);
    highModel ??= ask("high model", defaultHighModel, true);
  }
  if (ai !== "none" && (!lowModel || !highModel || !aiToken)) {
    die(
      "--token, --low-model, and --high-model are required when AI is enabled",
    );
  }

  return {
    command: command as Options["command"],
    repo,
    auth: choice("auth", ["gh", "pat"], "gh"),
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
    maxCommits: value("max-commits"),
    maxPrYears: value("max-pr-years"),
    maxPullRequestChangeLines: value("max-pull-request-change-lines"),
  };
}
