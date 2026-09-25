import type { Options } from "../types.ts";
import { prepareConfig } from "../config.ts";
import { getEnv } from "../util/runtime.ts";
import { askLine } from "./prompt.ts";
import { die } from "./error.ts";
import { detectRemoteRepo } from "../local/git_ops.ts";
import { reviewBlockingFrom } from "../review/blocking.ts";
import {
  renderCommandHelp,
  renderGlobalHelp,
  unknownCommandMessage,
  unknownOptionMessage,
} from "./commands/registry.ts";

function numberOption(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    die(`${name} must be a non-negative integer`);
  }
  return number;
}

const commands = ["probe", "init", "sync", "remake", "review"] as const;
export const defaultLowModel = "openai/gpt-oss-120b";
const defaultHighModel = "openai/gpt-5.6-luna";

let cliInteractive = true;

/** Plan §8.7 — `--json` must not prompt. */
export function setCliInteractive(value: boolean): void {
  cliInteractive = value;
}

async function ask(
  label: string,
  fallback?: string,
  required = false,
): Promise<string> {
  if (!cliInteractive) {
    if (fallback !== undefined && fallback !== "") return fallback;
    die(
      `Missing ${label}; pass it as a CLI option when running without an interactive terminal`,
    );
  }
  if (process.stdin.isTTY !== true) {
    die(
      `Missing ${label}; pass it as a CLI option when running without an interactive terminal`,
    );
  }
  const value = await askLine(label, fallback);
  if (required && !value) die(`${label} is required`);
  return value;
}

export async function parseArgs(args: string[]): Promise<Options> {
  const [command, repo, ...rest] = args;
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    repo === "--help" ||
    repo === "-h"
  ) {
    console.log(renderGlobalHelp());
    process.exit(0);
  }
  if (!commands.includes(command as (typeof commands)[number])) {
    die(unknownCommandMessage(command));
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(renderCommandHelp(command) ?? renderGlobalHelp());
    process.exit(0);
  }
  if (repo === "--help" || repo === "-h") {
    console.log(renderCommandHelp(command) ?? renderGlobalHelp());
    process.exit(0);
  }
  // `probe` (and only probe, for now) may omit the repo and let the current
  // directory's git remote name it (CORE-24).
  let repoName = repo;
  if ((!repoName || repoName.startsWith("-")) && command === "probe") {
    repoName = await detectRemoteRepo(process.cwd());
  }
  if (!repoName || !/^[^/]+\/[^/]+$/.test(repoName)) {
    die("Repository must look like owner/repo");
  }

  const { config, envPath } = prepareConfig(args);
  const env = (name: string): string | undefined => getEnv(name);
  const configDefault = config.defaults ?? {};
  // Remembered from a prior `init`/`remake` on this exact repo — never a
  // secret, so it can safely fill in everything except the API token.
  const repoConfig = config.repos?.[repoName] ?? {};
  const reviewBlocking = reviewBlockingFrom(
    env("CO_MAINTAINER_REVIEW_BLOCKING") ?? config.reviewBlocking,
  );

  let prNumber: number | undefined;
  if (command === "review") {
    const rawNumber = rest[0];
    if (rawNumber && /^\d+$/.test(rawNumber)) {
      rest.shift();
      prNumber = Number(rawNumber);
    }
  }

  const includeNames = [
    "include-codebase",
    "include-pull-requests",
    "include-pull-request-changes",
    "include-commit-history",
    "include-how-repo-works",
  ];
  const explicitlyIncluded = rest.some((arg) =>
    includeNames.some((name) => arg === `--${name}`),
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
      : (repoConfig[includeKeys[name]] ?? true);
  const value = (name: string): number | undefined => {
    const arg = rest.find((item) => item.startsWith(`--${name}=`));
    return arg
      ? numberOption(arg.slice(name.length + 3), `--${name}`)
      : undefined;
  };
  const text = (name: string): string | undefined =>
    rest.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  const prStateOption = (
    args: string[],
    saved: ("open" | "closed" | "merged")[] | undefined,
  ): ("open" | "closed" | "merged")[] | undefined => {
    const prefix = "--pr-state=";
    const raw = args
      .find((arg) => arg.startsWith(prefix))
      ?.slice(prefix.length);
    if (raw === undefined) return saved && saved.length > 0 ? saved : undefined;
    const allowed = ["open", "closed", "merged"] as const;
    const parts = raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (
      parts.length === 0 ||
      parts.some((part) => !allowed.includes(part as (typeof allowed)[number]))
    ) {
      die("pr-state must be a comma-separated list of: open, closed, merged");
    }
    return [...new Set(parts)] as ("open" | "closed" | "merged")[];
  };
  const choice = <T extends string>(
    name: string,
    allowed: T[],
    fallback: T,
  ): T => {
    const prefix = `--${name}=`;
    const raw = rest
      .find((arg) => arg.startsWith(prefix))
      ?.slice(prefix.length);
    if (!raw) return fallback;
    if (!allowed.includes(raw as T)) {
      die(`${name} must be one of: ${allowed.join(", ")}`);
    }
    return raw as T;
  };

  for (const arg of rest) {
    const known =
      includeNames.some((name) => arg === `--${name}`) ||
      [
        "max-commits",
        "max-pr-months",
        "max-pull-request-change-lines",
        "max-comment",
        "pr-state",
        "improve-matrix",
        "env",
        "gh-concurrent",
        "ai-concurrent",
        "auth",
        "ai",
        "token",
        "github-pat",
        "low-model",
        "high-model",
      ].some((name) => arg.startsWith(`--${name}=`));
    if (arg === "--codegraph") die("Unknown option: --codegraph");
    if (
      arg === "--debug" ||
      arg === "--log-time" ||
      arg === "--review-upstream" ||
      arg === "--disable-codegraph" ||
      arg === "--run" ||
      arg === "--only-request-changed-pr"
    )
      continue;
    if (arg.startsWith("--") && !known) die(unknownOptionMessage(arg, command));
  }

  const explicitAi = rest.some((arg) => arg.startsWith("--ai="));
  const configuredAiRaw = env("CO_MAINTAINER_AI") ?? repoConfig.ai ?? config.ai;
  if (
    configuredAiRaw &&
    !["none", "openrouter", "hetzner"].includes(configuredAiRaw)
  ) {
    die("CO_MAINTAINER_AI/config.ai must be none, openrouter, or hetzner");
  }
  const configuredAi = configuredAiRaw as Options["ai"] | undefined;
  const configuredAuthRaw =
    env("CO_MAINTAINER_AUTH") ?? repoConfig.auth ?? config.auth;
  if (configuredAuthRaw && !["gh", "pat"].includes(configuredAuthRaw)) {
    die("CO_MAINTAINER_AUTH/config.auth must be gh or pat");
  }
  const configuredAuth = configuredAuthRaw as Options["auth"] | undefined;
  const auth = choice("auth", ["gh", "pat"], configuredAuth ?? "gh");
  const githubPat =
    text("github-pat") ??
    env("GITHUB_TOKEN") ??
    env("GH_TOKEN") ??
    config.githubPat;
  if (auth === "pat" && !githubPat) {
    die(
      "--auth=pat requires a GitHub token. Pass --github-pat=..., set GITHUB_TOKEN/GH_TOKEN, " +
        "or run: co-maintainer set --github-pat=...",
    );
  }
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
  } else if (!explicitAi && !configuredAi && command !== "probe") {
    const selected = await ask(
      "AI provider (openrouter|hetzner)",
      "openrouter",
    );
    if (!["openrouter", "hetzner"].includes(selected)) {
      die("AI provider must be openrouter or hetzner");
    }
    ai = selected as Options["ai"];
  }
  let aiToken =
    text("token") ??
    env("CO_MAINTAINER_TOKEN") ??
    (ai === "openrouter" ? env("OPENROUTER_API_KEY") : undefined) ??
    (ai === "hetzner" ? env("HETZNER_API_KEY") : undefined) ??
    config.token;
  let lowModel =
    text("low-model") ??
    env("OPENROUTER_LOW_MODEL") ??
    env("HETZNER_LOW_MODEL") ??
    env("LOW_MODEL") ??
    repoConfig.lowModel ??
    config.lowModel;
  let highModel =
    text("high-model") ??
    env("OPENROUTER_HIGH_MODEL") ??
    env("HETZNER_HIGH_MODEL") ??
    env("HIGH_MODEL") ??
    repoConfig.highModel ??
    config.highModel;
  if (command === "review") {
    aiToken ??= await ask("openrouter API key", undefined, true);
    highModel ??= await ask("high model", defaultHighModel, true);
  } else if (ai !== "none" && command !== "probe") {
    aiToken ??= await ask(`${ai} API key`, undefined, true);
    lowModel ??= await ask("low model", defaultLowModel, true);
    highModel ??= await ask("high model", defaultHighModel, true);
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
    command: command === "sync" ? "remake" : (command as Options["command"]),
    repo: repoName,
    prNumber,
    debug: rest.includes("--debug"),
    logTime: rest.includes("--log-time"),
    reviewUpstream: rest.includes("--review-upstream"),
    run: rest.includes("--run"),
    useCodegraph:
      command === "review" ? !rest.includes("--disable-codegraph") : false,
    envPath,
    improveMatrix: value("improve-matrix") ?? 1,
    ghConcurrent: Math.max(1, value("gh-concurrent") ?? 1),
    aiConcurrent: Math.max(1, value("ai-concurrent") ?? 3),
    auth,
    githubPat,
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
    onlyRequestChangedPr:
      rest.includes("--only-request-changed-pr") ||
      repoConfig.onlyRequestChangedPr === true,
    prState: prStateOption(rest, repoConfig.prState),
    maxCommits:
      value("max-commits") ?? repoConfig.maxCommits ?? configDefault.maxCommits,
    maxPrMonths:
      value("max-pr-months") ??
      repoConfig.maxPrMonths ??
      configDefault.maxPrMonths,
    maxPullRequestChangeLines:
      value("max-pull-request-change-lines") ??
      repoConfig.maxPullRequestChangeLines ??
      configDefault.maxPullRequestChangeLines,
    maxComments: value("max-comment") ?? repoConfig.maxComments,
    reviewBlocking,
  };
}
