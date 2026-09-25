/** Recorded 0.4.13 CLI behaviour (CORE-02).
 *
 * These values are the contract. Later tasks may add cases here but must not
 * change an existing expectation, with one exception: the exit code change
 * approved as decision 2 in `dx-research/plans/README.md`, which CORE-10
 * implements. Those cases carry `exitCodeDecision` so the exception is visible
 * in review rather than buried in a diff.
 *
 * Everything is plain data. The test in `src/cli/compat.test.ts` computes the
 * same shapes from the real parser and compares, so a behaviour change fails
 * here instead of shipping.
 */
import type { Options } from "../../types.ts";

export type ParseCase = {
  name: string;
  args: string[];
  /** Expected `Options`, or `{ error: string }` when parsing must fail. */
  expect: Partial<Options> | { error: string };
  /** Keys that must be absent from the result. Empty assignments
   * (`includePullRequests: undefined` and a missing key) compare equal, so a
   * case that means "unset" has to say so explicitly. */
  absent?: (keyof Options)[];
};

export type ReviewModeCase = {
  name: string;
  args: string[];
  mode: "local" | "remote" | "pr";
  flags?: {
    json?: boolean;
    remote?: boolean;
    disableCodegraph?: boolean;
    allowToolInstall?: boolean;
    fresh?: boolean;
    toBranch?: string;
    branch?: string;
    repoOverride?: string;
    remakeBeforeReview?: boolean;
  };
  error?: string;
};

export type SetCase = {
  name: string;
  args: string[];
  /** Subset of the written config the case pins down after `args` runs. */
  config: Record<string, unknown>;
  /** Optional second invocation against the same config file, so two-step
   * flows such as set-then-unset can be pinned down. Not named `then`: a
   * `then` property makes the object thenable and `await` would call it. */
  thenArgs?: string[];
  /** Subset of the config after `thenArgs` runs, when it is present. */
  thenConfig?: Record<string, unknown>;
  /** Exact `[set] updated: ...` line, or a substring match via `contains`. */
  stdout?: string;
  contains?: string;
  error?: string;
};

export type HelpCase = {
  name: string;
  args: string[];
  exitCode: number;
  /** A line that must appear in stdout. */
  firstLine: string;
  exitCodeDecision?: string;
};

/** Fields `parseArgs` always returns, so a case only lists what it changes. */
export const PARSE_DEFAULTS: Partial<Options> = {
  debug: false,
  logTime: false,
  reviewUpstream: false,
  useCodegraph: false,
  improveMatrix: 1,
  ghConcurrent: 1,
  aiConcurrent: 3,
  auth: "gh",
  ai: "none",
  synthesisVersion: 16,
  includeCodebase: true,
  includePullRequests: true,
  includePullRequestChanges: true,
  includeCommitHistory: true,
  includeHowRepoWorks: true,
  onlyRequestChangedPr: false,
};

export const PARSE_CASES: ParseCase[] = [
  {
    name: "probe with no flags keeps every source enabled and no AI",
    args: ["probe", "owner/repo"],
    expect: { command: "probe", repo: "owner/repo" },
  },
  {
    name: "init with --ai=none needs no token and defaults every source on",
    args: ["init", "owner/repo", "--ai=none"],
    expect: { command: "init", repo: "owner/repo" },
  },
  {
    name: "one --include flag disables every other source",
    args: ["init", "owner/repo", "--ai=none", "--include-codebase"],
    expect: {
      command: "init",
      repo: "owner/repo",
      includeCodebase: true,
      includePullRequests: false,
      includePullRequestChanges: false,
      includeCommitHistory: false,
      includeHowRepoWorks: false,
    },
  },
  {
    name: "two --include flags enable exactly those two",
    args: [
      "init",
      "owner/repo",
      "--ai=none",
      "--include-codebase",
      "--include-commit-history",
    ],
    expect: {
      command: "init",
      repo: "owner/repo",
      includeCodebase: true,
      includePullRequests: false,
      includePullRequestChanges: false,
      includeCommitHistory: true,
      includeHowRepoWorks: false,
    },
  },
  {
    name: "limit flags parse as non-negative integers",
    args: [
      "init",
      "owner/repo",
      "--ai=none",
      "--max-commits=50",
      "--max-pr-months=6",
      "--max-pull-request-change-lines=1200",
      "--max-comment=7",
    ],
    expect: {
      command: "init",
      repo: "owner/repo",
      maxCommits: 50,
      maxPrMonths: 6,
      maxPullRequestChangeLines: 1200,
      maxComments: 7,
    },
  },
  {
    name: "pr-state keeps only the listed states and de-duplicates",
    args: ["init", "owner/repo", "--ai=none", "--pr-state=open,merged,open"],
    expect: {
      command: "init",
      repo: "owner/repo",
      prState: ["open", "merged"],
    },
  },
  {
    name: "only-request-changed-pr is a boolean switch",
    args: ["init", "owner/repo", "--ai=none", "--only-request-changed-pr"],
    expect: {
      command: "init",
      repo: "owner/repo",
      onlyRequestChangedPr: true,
    },
  },
  {
    name: "auth gh is the default and needs no token",
    args: ["init", "owner/repo", "--ai=none"],
    expect: { command: "init", repo: "owner/repo", auth: "gh" },
  },
  {
    name: "auth pat reads the token from --github-pat",
    args: [
      "init",
      "owner/repo",
      "--ai=none",
      "--auth=pat",
      "--github-pat=ghp_x",
    ],
    expect: {
      command: "init",
      repo: "owner/repo",
      auth: "pat",
      githubPat: "ghp_x",
    },
  },
  {
    name: "openrouter carries token and both model names",
    args: [
      "init",
      "owner/repo",
      "--ai=openrouter",
      "--token=tok",
      "--low-model=low/model",
      "--high-model=high/model",
    ],
    expect: {
      command: "init",
      repo: "owner/repo",
      ai: "openrouter",
      aiToken: "tok",
      lowModel: "low/model",
      highModel: "high/model",
    },
  },
  {
    name: "review forces openrouter and defaults the high model",
    args: ["review", "owner/repo", "42", "--token=tok"],
    expect: {
      command: "review",
      repo: "owner/repo",
      prNumber: 42,
      ai: "openrouter",
      aiToken: "tok",
      highModel: "openai/gpt-5.6-luna",
      useCodegraph: true,
    },
  },
  {
    name: "review without a PR number leaves prNumber unset",
    args: ["review", "owner/repo", "--token=tok"],
    expect: {
      command: "review",
      repo: "owner/repo",
      ai: "openrouter",
      highModel: "openai/gpt-5.6-luna",
      useCodegraph: true,
    },
    absent: ["prNumber"],
  },
  {
    name: "review --disable-codegraph turns codegraph off",
    args: ["review", "owner/repo", "42", "--token=tok", "--disable-codegraph"],
    expect: {
      command: "review",
      repo: "owner/repo",
      prNumber: 42,
      ai: "openrouter",
      useCodegraph: false,
    },
  },
  {
    name: "debug, log-time, concurrency and improve-matrix",
    args: [
      "init",
      "owner/repo",
      "--ai=none",
      "--debug",
      "--log-time",
      "--gh-concurrent=4",
      "--ai-concurrent=2",
      "--improve-matrix=3",
    ],
    expect: {
      command: "init",
      repo: "owner/repo",
      debug: true,
      logTime: true,
      ghConcurrent: 4,
      aiConcurrent: 2,
      improveMatrix: 3,
    },
  },
  {
    name: "remake is a first-class command, not an alias yet",
    args: ["remake", "owner/repo", "--ai=none"],
    expect: { command: "remake", repo: "owner/repo" },
  },
  {
    name: "--env records the path it loaded",
    // The one case whose input cannot be a plain literal: `--env` loads a real
    // file, and a temp dir only exists at run time. `${DIR}` is substituted
    // with the isolated temp dir before parsing, so the recorded shape and the
    // executed input are the same string.
    args: ["init", "owner/repo", "--ai=none", "--env=${DIR}/compat.env"],
    expect: {
      command: "init",
      repo: "owner/repo",
      envPath: "${DIR}/compat.env",
    },
  },
  {
    name: "concurrency floors at one",
    args: ["init", "owner/repo", "--ai=none", "--gh-concurrent=0"],
    expect: { command: "init", repo: "owner/repo", ghConcurrent: 1 },
  },
  {
    name: "unknown command is rejected",
    args: ["prob", "owner/repo"],
    expect: { error: "Unknown command: prob. Did you mean probe?" },
  },
  {
    name: "unknown option is rejected",
    args: ["init", "owner/repo", "--ai=none", "--nope"],
    expect: { error: "Unknown option: --nope" },
  },
  {
    name: "repo must look like owner/repo",
    args: ["init", "owneronly", "--ai=none"],
    expect: { error: "Repository must look like owner/repo" },
  },
  {
    name: "auth pat without a token names the fix",
    args: ["init", "owner/repo", "--ai=none", "--auth=pat"],
    expect: {
      error:
        "--auth=pat requires a GitHub token. Pass --github-pat=..., set GITHUB_TOKEN/GH_TOKEN, or run: co-maintainer set --github-pat=...",
    },
  },
  {
    name: "bad pr-state lists the allowed values",
    args: ["init", "owner/repo", "--ai=none", "--pr-state=opened"],
    expect: {
      error: "pr-state must be a comma-separated list of: open, closed, merged",
    },
  },
  {
    name: "bad ai value lists the providers",
    args: ["init", "owner/repo", "--ai=gemini"],
    expect: { error: "ai must be one of: none, openrouter" },
  },
  {
    name: "--codegraph is explicitly rejected with a pointer",
    args: ["init", "owner/repo", "--ai=none", "--codegraph"],
    expect: { error: "Unknown option: --codegraph" },
  },
  {
    name: "a negative limit is rejected",
    args: ["init", "owner/repo", "--ai=none", "--max-commits=-1"],
    expect: { error: "--max-commits must be a non-negative integer" },
  },
];

export const REVIEW_MODE_CASES: ReviewModeCase[] = [
  {
    name: "bare review is local mode",
    args: [],
    mode: "local",
    flags: {
      json: false,
      remote: false,
      disableCodegraph: false,
      allowToolInstall: false,
      fresh: false,
      remakeBeforeReview: false,
    },
  },
  {
    name: "--remote is remote mode",
    args: ["--remote"],
    mode: "remote",
    flags: { remote: true },
  },
  {
    name: "owner/repo plus a number is PR mode",
    args: ["owner/repo", "42", "--token=tok", "--high-model=high/model"],
    mode: "pr",
    flags: {},
  },
  {
    name: "review flags are captured together",
    args: [
      "owner/repo",
      "42",
      "--token=tok",
      "--high-model=high/model",
      "--json",
      "--fresh",
      "--disable-codegraph",
      "--allow-tool-install",
      "--to-branch=main",
      "--branch=feature",
      "--repo=other/repo",
    ],
    mode: "pr",
    flags: {
      json: true,
      fresh: true,
      disableCodegraph: true,
      allowToolInstall: true,
      toBranch: "main",
      branch: "feature",
      repoOverride: "other/repo",
    },
  },
  {
    name: "--remake-before-review is refused for a PR review",
    args: [
      "owner/repo",
      "42",
      "--token=tok",
      "--high-model=high/model",
      "--remake-before-review",
    ],
    mode: "pr",
    error: "--sync-before-review is not supported for PR review",
  },
  {
    name: "--remote with --remake-before-review is refused",
    args: ["--remote", "--remake-before-review"],
    mode: "remote",
    error: "--sync-before-review cannot be used with --remote",
  },
];

export const SET_CASES: SetCase[] = [
  {
    name: "set writes the provider, auth and both models",
    args: [
      "--ai=openrouter",
      "--auth=gh",
      "--token=tok",
      "--low-model=low/model",
      "--high-model=high/model",
      // The fixture key and model are not real, and `set` verifies them against
      // OpenRouter before writing (CORE-22). Offline compat runs skip that
      // check; the verification path has its own test in config.test.ts.
      "--no-verify",
    ],
    config: {
      ai: "openrouter",
      auth: "gh",
      token: "tok",
      lowModel: "low/model",
      highModel: "high/model",
    },
    stdout:
      "[set] updated: ai=openrouter, auth=gh, lowModel=low/model, highModel=high/model, token=••••••••",
  },
  {
    name: "set stores the GitHub App credentials",
    args: [
      "--github-app-id=123",
      "--github-webhook-secret=whsec",
      "--github-app-private-key=KEY",
    ],
    config: {
      githubAppId: "123",
      githubWebhookSecret: "whsec",
      githubAppPrivateKey: "KEY",
    },
    contains: "[set] updated:",
  },
  {
    name: "set stores the App key path without touching the file",
    args: ["--github-app-id=123", "--github-app-private-key-path=./app.pem"],
    config: {
      githubAppId: "123",
      githubAppPrivateKeyPath: "./app.pem",
    },
    contains: "githubAppPrivateKeyPath=./app.pem",
  },
  {
    name: "set stores the remote review target",
    args: ["--remote-host=https://example.test", "--remote-token=rtok"],
    config: {
      remoteHost: "https://example.test",
      remoteToken: "rtok",
    },
    contains: "remoteHost=https://example.test",
  },
  {
    name: "set --unset clears a value that a previous run wrote",
    args: ["--token=tok", "--ai=openrouter", "--no-verify"],
    config: { token: "tok", ai: "openrouter" },
    thenArgs: ["--unset=token"],
    thenConfig: { ai: "openrouter" },
    contains: "[set] updated:",
  },
  {
    name: "set with no arguments prints usage instead of failing",
    args: [],
    config: {},
    contains: "co-maintainer set [options]",
  },
  {
    name: "set refuses an unknown option",
    args: ["--nope=1"],
    config: {},
    error: "Unknown option: --nope=1",
  },
  {
    name: "set refuses a bad auth value",
    args: ["--auth=oauth"],
    config: {},
    error: "--auth must be one of: gh, pat",
  },
  {
    name: "set refuses two private key spellings at once",
    args: ["--github-app-private-key=A", "--github-app-private-key-file=x"],
    config: {},
    error:
      "Pass only one of --github-app-private-key, --github-app-private-key-file, or --github-app-private-key-path",
  },
];

export const HELP_CASES: HelpCase[] = [
  {
    name: "no arguments prints usage and exits 0",
    args: [],
    exitCode: 0,
    firstLine: "Usage: co-maintainer <command> owner/repo [options]",
  },
  {
    name: "help prints usage and exits 0",
    args: ["help"],
    exitCode: 0,
    firstLine: "Usage: co-maintainer <command> owner/repo [options]",
  },
  {
    name: "--help prints usage and exits 0",
    args: ["--help"],
    exitCode: 0,
    firstLine: "Usage: co-maintainer <command> owner/repo [options]",
  },
  {
    name: "-h prints usage and exits 0",
    args: ["-h"],
    exitCode: 0,
    firstLine: "Usage: co-maintainer <command> owner/repo [options]",
  },
  {
    name: "--version prints the version and exits 0",
    args: ["--version"],
    exitCode: 0,
    firstLine: "VERSION",
  },
  {
    name: "-v prints the version and exits 0",
    args: ["-v"],
    exitCode: 0,
    firstLine: "VERSION",
  },
];
