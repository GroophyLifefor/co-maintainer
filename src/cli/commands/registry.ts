/** The command registry.
 *
 * One place that knows every command, its aliases, its usage lines, its flags
 * and its examples. Everything the user reads as help is rendered from here,
 * so a flag cannot drift out of the help and a command cannot be documented
 * twice with different wording. It is also the source the command reference is
 * generated from, which is why it is data rather than template strings.
 */
import { AI_PROVIDERS } from "../../ai/provider.ts";

export type FlagSpec = {
  /** Without the leading dashes, e.g. `include-codebase`. */
  name: string;
  /** The value placeholder when the flag takes one, e.g. `N` in `--port=N`. */
  value?: string;
  default?: string;
  description: string;
};

export type FlagGroup = {
  title: string;
  flags: FlagSpec[];
};

export type CommandSpec = {
  name: string;
  /** Other spellings that run the same handler. Hidden aliases stay out of the
   * global help but still resolve. */
  aliases?: string[];
  /** A hidden command is resolvable but never listed. */
  hidden?: boolean;
  summary: string;
  usage: string[];
  groups: FlagGroup[];
  examples: string[];
  docs?: string;
};

const OUTPUT_FLAGS: FlagGroup = {
  title: "Output and diagnostics",
  flags: [
    {
      name: "json",
      description: "Print machine-readable JSON instead of prose.",
    },
    { name: "debug", description: "Print the underlying gh and HTTP calls." },
    { name: "log-time", description: "Print how long each phase took." },
    {
      name: "env",
      value: "PATH",
      description:
        "Read environment variables from a .env file first. A variable already set wins.",
    },
  ],
};

/** `serve` runs until stopped and prints no result, so it has no `--json`. */
const SERVE_OUTPUT_FLAGS: FlagGroup = {
  title: OUTPUT_FLAGS.title,
  flags: [
    {
      name: "debug",
      description:
        "Turn on the /__ui component gallery. CM_DEBUG=1 does the same.",
    },
  ],
};

/** `review` alone can print for a CI run. */
const REVIEW_OUTPUT_FLAGS: FlagGroup = {
  title: OUTPUT_FLAGS.title,
  flags: [
    ...OUTPUT_FLAGS.flags,
    {
      name: "output",
      value: "github",
      description:
        "Print GitHub workflow annotations and write the job summary instead of prose. Cannot be used with --json.",
    },
    {
      name: "include-extension-markdowns",
      description:
        "With --json, keep each extension's markdown. It is empty otherwise.",
    },
  ],
};

const AI_KEY_FLAGS: FlagSpec[] = [
  { name: "token", value: "KEY", description: "The provider API key." },
  {
    name: "ai-key",
    value: "KEY",
    description: "The same key as --token, named for what it is.",
  },
  {
    name: "low-model",
    value: "ID",
    description: "Model for extraction work.",
  },
  {
    name: "high-model",
    value: "ID",
    description: "Model for the review itself.",
  },
];

const AI_FLAGS: FlagGroup = {
  title: "AI",
  flags: [
    {
      name: "ai",
      value: AI_PROVIDERS.join("|"),
      default: "none",
      description: "Which provider writes the review. `none` turns AI off.",
    },
    ...AI_KEY_FLAGS,
  ],
};

/** A review cannot run without AI, so `none`, or nothing saved, means
 * OpenRouter there, the provider every review used before providers. */
const REVIEW_AI_FLAGS: FlagGroup = {
  title: "AI",
  flags: [
    {
      name: "ai",
      value: AI_PROVIDERS.filter((provider) => provider !== "none").join("|"),
      description:
        "Which provider writes the review. With none saved, OpenRouter. --ai=none is refused.",
    },
    ...AI_KEY_FLAGS,
  ],
};

const PR_FILTER_FLAGS: FlagGroup = {
  title: "Pull request filter",
  flags: [
    {
      name: "pr-state",
      value: "open,closed,merged",
      description: "Which pull request states to read.",
    },
    {
      name: "only-request-changed-pr",
      description:
        "Read only the pull requests with at least one CHANGES_REQUESTED review. Saved for the repository.",
    },
    {
      name: "no-only-request-changed-pr",
      description:
        "Read every pull request again, turning a saved --only-request-changed-pr off.",
    },
  ],
};

/** `init` and `sync` author every guide with AI, so no provider is not a
 * choice there. */
const AI_FLAGS_REQUIRED: FlagGroup = {
  title: "AI",
  flags: [
    {
      name: "ai",
      value: AI_PROVIDERS.filter((provider) => provider !== "none").join("|"),
      description:
        "Which provider writes the guides. Required: init and sync cannot run without one.",
    },
    ...AI_KEY_FLAGS,
  ],
};

/** `--experimental-siwc`: run on a ChatGPT plan through Sign in with ChatGPT
 * instead of an API key. Its own group so it reads as not yet settled. */
const EXPERIMENTAL_FLAGS: FlagGroup = {
  title: "Experimental",
  flags: [
    {
      name: "experimental-siwc",
      description:
        "Run on your ChatGPT plan through Sign in with ChatGPT instead of an API key. Cannot be combined with --ai. Set up with co-maintainer oauth.",
    },
  ],
};

const GITHUB_FLAGS: FlagGroup = {
  title: "GitHub access",
  flags: [
    {
      name: "auth",
      value: "gh|pat",
      default: "gh",
      description: "Use the gh CLI or a personal access token.",
    },
    {
      name: "github-pat",
      value: "TOKEN",
      description: "The token when --auth=pat.",
    },
  ],
};

/** `extension`: register external commands whose results join a review. */
const EXTENSION_COMMAND: CommandSpec = {
  name: "extension",
  summary: "Register external commands whose results join every review.",
  usage: [
    "co-maintainer extension register --name=NAME --command=COMMAND [options]",
    "co-maintainer extension update --name=NAME [options]",
    "co-maintainer extension list [--json]",
    "co-maintainer extension remove --name=NAME",
    "co-maintainer extension disable --name=NAME",
    "co-maintainer extension enable --name=NAME",
    "co-maintainer extension debug-run --name=NAME [--command=COMMAND]",
  ],
  groups: [
    {
      title: "Extension",
      flags: [
        {
          name: "name",
          value: "NAME",
          description: "The extension's name. Required.",
        },
        {
          name: "command",
          value: "COMMAND",
          description:
            "The shell command to run. {{details_path}}, {{review_result_path}} and {{diff_path}} are replaced with quoted paths. Required for register.",
        },
        {
          name: "repos",
          value: "PATTERNS",
          default: "*",
          description: "Where it runs: owner/repo, a/b,a/c, a/*, */a or *.",
        },
        {
          name: "review-types",
          value: "local,pr,remote",
          default: "all",
          description:
            "Only run in these review types. The extension can also check the type itself and return skipped.",
        },
      ],
    },
    {
      title: "Order",
      flags: [
        {
          name: "run-after",
          value: "NAME|review",
          description:
            "Start when this extension, or the AI review, has finished. A name nobody registered asks first.",
        },
        {
          name: "parallelism",
          value: "true|false",
          default: "true",
          description:
            "false with no --run-after means it runs after the review.",
        },
        {
          name: "priority",
          value: "0-3",
          default: "0",
          description:
            "Start order among extensions ready at the same time. 3 runs first, ties keep registration order.",
        },
        {
          name: "fail-fast",
          description:
            "On failure, the extensions waiting on this one through --run-after do not run.",
        },
      ],
    },
    {
      title: "Retries and limits",
      flags: [
        {
          name: "retry-on-fail-times",
          value: "N",
          default: "0",
          description: "Run again when the response does not match the schema.",
        },
        {
          name: "max-requested-retries",
          value: "N",
          default: "3",
          description: "How many status retry responses are honoured.",
        },
        {
          name: "timeout",
          value: "DURATION",
          default: "10m",
          description:
            "Stop a run after this long, such as 30s, 10m or 1h. The result is Failed.",
        },
        {
          name: "rerun-on-restart",
          value: "true|false",
          default: "true",
          description:
            "Run again when co-maintainer restarted mid-run. Overrides the extension-rerun-on-restart config key.",
        },
        {
          name: "yes",
          description:
            "Save a --run-after that names an unregistered extension without asking.",
        },
      ],
    },
    {
      title: "Output",
      flags: [
        {
          name: "json",
          description: "With list, print the registrations as JSON.",
        },
      ],
    },
  ],
  examples: [
    "co-maintainer extension register --name=qa-vision --command='HOME=/home/me /usr/bin/node /opt/qa-vision.mjs {{details_path}} --json'",
    "co-maintainer extension register --name=lint --command='/opt/lint.sh {{diff_path}}' --review-types=pr --fail-fast",
    "co-maintainer extension update --name=lint --run-after=review --priority=3",
    "co-maintainer extension debug-run --name=qa-vision",
    "co-maintainer extension list",
  ],
};

export const COMMANDS: CommandSpec[] = [
  {
    name: "probe",
    summary: "Inspect a repository and recommend the init flags for it.",
    usage: ["co-maintainer probe owner/repo [options]"],
    groups: [
      GITHUB_FLAGS,
      {
        title: "Limits",
        flags: [
          {
            name: "max-pull-request-change-lines",
            value: "N",
            description: "Cap the diff size sampled.",
          },
          {
            name: "max-pr-months",
            value: "N",
            description: "Cap how far back pull requests are read.",
          },
          {
            name: "max-commits",
            value: "N",
            description: "Cap how many commits are read.",
          },
        ],
      },
      {
        title: "After the plan",
        flags: [
          {
            name: "run",
            description: "Run the recommended init in this same process.",
          },
        ],
      },
      OUTPUT_FLAGS,
    ],
    examples: [
      "co-maintainer probe owner/repo",
      "co-maintainer probe owner/repo --run",
      "co-maintainer probe owner/repo --log-time",
    ],
  },
  {
    name: "init",
    summary: "Build the review guides for a repository for the first time.",
    usage: ["co-maintainer init owner/repo [options]"],
    groups: [
      {
        title: "Sources",
        flags: [
          { name: "include-codebase", description: "Read the source tree." },
          {
            name: "include-pull-requests",
            description: "Read pull request history.",
          },
          {
            name: "include-pull-request-changes",
            description: "Read the diffs of those pull requests.",
          },
          {
            name: "include-commit-history",
            description: "Read commit history.",
          },
          {
            name: "include-how-repo-works",
            description: "Read the docs and layout.",
          },
          {
            name: "agent-instructions",
            value: "REGEX",
            default: "(^|/)AGENTS\\.md$",
            description:
              "Paths on the default branch to read as agent instruction files for INSTRUCTIONS.md. Needs --include-codebase. A blank value turns it off. Saved for later syncs.",
          },
        ],
      },
      {
        title: "Limits",
        flags: [
          {
            name: "max-commits",
            value: "N",
            default: "all",
            description: "Cap how many commits are read.",
          },
          {
            name: "agent-instructions-max-chars",
            value: "N",
            default: "6000",
            description:
              "Cap on INSTRUCTIONS.md in characters. 0 or below means no limit. Saved for later syncs.",
          },
          {
            name: "max-pr-months",
            value: "N",
            default: "all",
            description: "Cap how far back pull requests are read.",
          },
          {
            name: "max-pull-request-change-lines",
            value: "N",
            default: "all",
            description: "Cap the diff size read.",
          },
          {
            name: "max-comment",
            value: "N",
            description: "Cap the comments read per pull request.",
          },
        ],
      },
      PR_FILTER_FLAGS,
      AI_FLAGS_REQUIRED,
      EXPERIMENTAL_FLAGS,
      GITHUB_FLAGS,
      OUTPUT_FLAGS,
      {
        title: "Performance",
        flags: [
          {
            name: "gh-concurrent",
            value: "N",
            default: "1",
            description:
              "Concurrent GitHub calls for this run only. It does not change the saved default.",
          },
          {
            name: "ai-concurrent",
            value: "N",
            default: "3",
            description:
              "Concurrent AI calls for this run only. It does not change the saved default.",
          },
        ],
      },
    ],
    examples: [
      "co-maintainer init owner/repo --include-codebase --include-pull-requests",
      "co-maintainer init owner/repo --include-codebase --ai=openrouter --token=...",
      "co-maintainer init owner/repo --max-pr-months=12 --agent-instructions='(^|/)(AGENTS|CLAUDE)\\.md$'",
    ],
  },
  {
    name: "sync",
    // `remake` is the 0.4.13 spelling. It still runs the same handler but is
    // not advertised, so nothing the user reads says "remake".
    aliases: ["remake"],
    summary:
      "Rebuild the review guides for a repository that already has them.",
    usage: ["co-maintainer sync owner/repo [options]"],
    groups: [
      {
        title: "Sources",
        flags: [
          { name: "include-codebase", description: "Read the source tree." },
          {
            name: "include-pull-requests",
            description: "Read pull request history.",
          },
          {
            name: "include-pull-request-changes",
            description: "Read the diffs of those pull requests.",
          },
          {
            name: "include-commit-history",
            description: "Read commit history.",
          },
          {
            name: "include-how-repo-works",
            description: "Read the docs and layout.",
          },
          {
            name: "agent-instructions",
            value: "REGEX",
            description:
              "Paths on the default branch to read as agent instruction files for INSTRUCTIONS.md. Needs --include-codebase. A blank value turns it off. Left out, the last run's value is kept.",
          },
        ],
      },
      {
        title: "Limits",
        flags: [
          {
            name: "max-commits",
            value: "N",
            description: "Cap how many commits are read.",
          },
          {
            name: "agent-instructions-max-chars",
            value: "N",
            description:
              "Cap on INSTRUCTIONS.md in characters. 0 or below means no limit. Left out, the last run's value is kept.",
          },
          {
            name: "max-pr-months",
            value: "N",
            description: "Cap how far back pull requests are read.",
          },
          {
            name: "max-pull-request-change-lines",
            value: "N",
            description: "Cap the diff size read.",
          },
          {
            name: "max-comment",
            value: "N",
            description: "Cap the comments read per pull request.",
          },
        ],
      },
      PR_FILTER_FLAGS,
      AI_FLAGS_REQUIRED,
      EXPERIMENTAL_FLAGS,
      GITHUB_FLAGS,
      OUTPUT_FLAGS,
      {
        title: "Performance",
        flags: [
          {
            name: "gh-concurrent",
            value: "N",
            default: "1",
            description:
              "Concurrent GitHub calls for this run only. It does not change the saved default.",
          },
          {
            name: "ai-concurrent",
            value: "N",
            default: "3",
            description:
              "Concurrent AI calls for this run only. It does not change the saved default.",
          },
        ],
      },
      {
        title: "Review guide",
        flags: [
          {
            name: "full-guide",
            description:
              "Rewrite the review guide in full now, instead of editing it, and start the count of --guide-full-every again.",
          },
        ],
      },
    ],
    examples: [
      "co-maintainer sync owner/repo --include-codebase",
      "co-maintainer sync owner/repo --agent-instructions-max-chars=8000",
    ],
  },
  {
    name: "review",
    summary: "Review a pull request, or the local changes in this workspace.",
    usage: [
      "co-maintainer review owner/repo PR_NUMBER [options]",
      "co-maintainer review [options]",
    ],
    groups: [
      {
        title: "Target",
        flags: [
          {
            name: "repo",
            value: "owner/repo",
            description: "The repository the local changes belong to.",
          },
          {
            name: "branch",
            value: "NAME",
            description: "The branch the local changes are on.",
          },
          {
            name: "to-branch",
            value: "NAME",
            description: "Compare the local changes against this branch.",
          },
          {
            name: "fresh",
            description: "Ignore the previous review and start over.",
          },
        ],
      },
      {
        title: "Local only",
        flags: [
          {
            name: "remote",
            description:
              "Send the diff to the configured remote server instead of reviewing locally.",
          },
          {
            name: "remote-host",
            value: "URL",
            description:
              "Override the configured remote host for this run (needs --remote).",
          },
          {
            name: "remote-token",
            value: "TOKEN",
            description:
              "Override the configured remote token for this run (needs --remote).",
          },
          {
            name: "remote-byok",
            description:
              "Send your own AI key with a remote review (needs --remote).",
          },
          {
            name: "no-remote-byok",
            description:
              "Do not send your own AI key, even if remote-byok-default is on.",
          },
          {
            name: "sync-before-review",
            description: "Rebuild the guides before reviewing.",
          },
        ],
      },
      {
        title: "Codegraph",
        flags: [
          {
            name: "disable-codegraph",
            description: "Skip the codegraph index.",
          },
          {
            name: "allow-tool-install",
            description: "Install codegraph if it is missing.",
          },
        ],
      },
      {
        title: "Custom instructions",
        flags: [
          {
            name: "system-prompt-file",
            value: "PATH",
            description:
              "Append this file's contents to the review instructions for this run only.",
          },
          {
            name: "system-prompt-override-file",
            value: "PATH",
            description:
              "Replace the repository's review instructions with this file for this run only. The built-in instructions are kept.",
          },
          {
            name: "range",
            value: "BEFORE..AFTER",
            description:
              "With --remote: review a push (commit watch). The server keeps the review going if this run stops waiting.",
          },
          {
            name: "timeout-minutes",
            value: "N",
            description:
              "With --range: stop waiting after N minutes and leave the result to the dashboard, default 10. With --remote on a pull request: fail with exit code 3 after N minutes, no limit by default.",
          },
        ],
      },
      {
        title: "Intent",
        flags: [
          {
            name: "intent-file",
            value: "PATH",
            description:
              "Tell the review what the change is for, from a file or from standard input with -. It is context only, never a rule. Up to the repository's custom prompt cap. Not with --range.",
          },
        ],
      },
      {
        title: "Companions",
        flags: [
          {
            name: "with",
            value: "PATH[@BRANCH]",
            description:
              "Read the changes of another checkout as context, such as the docs or a client of this code. Without @BRANCH its current branch and working tree, with @BRANCH that branch against its default branch, without a checkout. Repeat it for each companion, up to 5. Not with --range.",
          },
        ],
      },
      {
        title: "Diagrams",
        flags: [
          {
            name: "diagram-runtime",
            value: "mermaid|plantuml|plantuml-server",
            default: "mermaid",
            description:
              "The diagram language the review uses. plantuml keeps the PlantUML source. plantuml-server turns it into an image link on a PlantUML server. Not with --remote.",
          },
          {
            name: "plantuml-server",
            value: "URL",
            default: "https://www.plantuml.com",
            description:
              "The PlantUML server for plantuml-server. An http or https URL. The diagram source travels in the image link.",
          },
          {
            name: "plantuml-output-format",
            value: "svg|png",
            default: "svg",
            description: "The image format for plantuml-server.",
          },
        ],
      },
      {
        title: "Depth",
        flags: [
          {
            name: "improve-matrix",
            value: "N",
            default: "1",
            description:
              "How many passes the review model makes over its own findings. Capped at 4, and each pass costs more.",
          },
          {
            name: "review-upstream",
            description:
              "On a pull request, review the code merged in from the base branch too, not only what the author wrote.",
          },
        ],
      },
      REVIEW_AI_FLAGS,
      EXPERIMENTAL_FLAGS,
      GITHUB_FLAGS,
      REVIEW_OUTPUT_FLAGS,
    ],
    examples: [
      "co-maintainer review owner/repo 42 --json",
      "co-maintainer review --json --disable-codegraph",
      "co-maintainer review --remote --json",
      "co-maintainer review --remote --remote-host=https://review.example.com --remote-token=cmr_...",
      "co-maintainer review --remote --remote-byok --json",
      "co-maintainer review --remote --output=github",
      "co-maintainer review --remote --range=abc1234..def5678 --output=github",
      "co-maintainer review owner/repo 42 --system-prompt-file=extra.md",
      "co-maintainer review --system-prompt-override-file=strict.md",
      "co-maintainer review --intent-file=task.md",
      "co-maintainer review --with=../docs --with=../vscode-ext@feature/session-api",
      "co-maintainer review owner/repo 42 --diagram-runtime=plantuml-server --plantuml-output-format=png",
    ],
  },
  {
    name: "config",
    summary: "Read and edit the user config without opening the file.",
    usage: [
      "co-maintainer config list",
      "co-maintainer config get <key>",
      "co-maintainer config set <key> <value>",
      "co-maintainer config unset <key>",
      "co-maintainer config path [--all]",
    ],
    groups: [
      {
        title: "Subcommands",
        flags: [
          {
            name: "all",
            description:
              "With `path`, also print the repos and cache directories.",
          },
        ],
      },
    ],
    examples: [
      "co-maintainer config list",
      "co-maintainer config get high-model",
      "co-maintainer config set remote-host https://review.example.com",
      "co-maintainer config path --all",
    ],
  },
  {
    name: "view",
    summary: "Print the guides co-maintainer generated for a repository.",
    usage: [
      "co-maintainer view [owner/repo] [guide]",
      "co-maintainer view [owner/repo] --list",
      "co-maintainer view [owner/repo] --path",
      "co-maintainer view [owner/repo] --sources [--json]",
    ],
    groups: [
      {
        title: "Guides",
        flags: [
          {
            name: "list",
            description: "List the guide files with their size and build date.",
          },
          {
            name: "sources",
            description:
              "List every guide and instruction rule by id, with the pull requests or instruction file lines it came from.",
          },
          {
            name: "json",
            description: "With --sources, print RULES.json as it is.",
          },
          {
            name: "path",
            description: "Print the directory the guides live in.",
          },
          {
            name: "remote",
            description:
              "Read the guides from the configured remote review server instead.",
          },
        ],
      },
    ],
    examples: [
      "co-maintainer view",
      "co-maintainer view owner/repo review-guide",
      "co-maintainer view owner/repo --list",
      "co-maintainer view owner/repo --remote",
      "co-maintainer view owner/repo --sources",
    ],
  },
  {
    name: "clear",
    summary:
      "Delete the generated guides and saved settings for a repository, or for every repository.",
    usage: ["co-maintainer clear <owner/repo|all> [options]"],
    groups: [
      {
        title: "Clear",
        flags: [
          {
            name: "include-cache",
            description:
              "Also delete the fetched evidence: pull request listings, AI job cache, costs, local review carry-over, clones and worktrees. The next init is then a cold build.",
          },
          {
            name: "yes",
            description:
              "Skip the confirmation `all` asks. Needed when there is no terminal.",
          },
        ],
      },
    ],
    examples: [
      "co-maintainer clear owner/repo",
      "co-maintainer clear owner/repo --include-cache",
      "co-maintainer clear all --include-cache --yes",
    ],
  },
  {
    name: "uninstall",
    summary: "Delete every co-maintainer data file on this machine.",
    usage: ["co-maintainer uninstall [--yes]"],
    groups: [
      {
        title: "Uninstall",
        flags: [
          {
            name: "yes",
            description:
              "Skip the confirmation. Needed when there is no terminal.",
          },
        ],
      },
    ],
    examples: ["co-maintainer uninstall", "co-maintainer uninstall --yes"],
  },
  {
    name: "oauth",
    summary: "Sign in to an OAuth AI provider (experimental).",
    usage: [
      "co-maintainer oauth login --provider=sign-in-with-chatgpt",
      "co-maintainer oauth logout --provider=sign-in-with-chatgpt",
      "co-maintainer oauth refresh --provider=sign-in-with-chatgpt",
      "co-maintainer oauth ping --provider=sign-in-with-chatgpt",
      "co-maintainer oauth list-models --provider=sign-in-with-chatgpt",
    ],
    groups: [
      {
        title: "OAuth",
        flags: [
          {
            name: "provider",
            value: "sign-in-with-chatgpt",
            description:
              "Which provider to sign in to. `siwc` is accepted as a short alias.",
          },
        ],
      },
    ],
    examples: [
      "co-maintainer oauth login --provider=sign-in-with-chatgpt",
      "co-maintainer oauth list-models --provider=siwc",
    ],
  },
  {
    name: "set",
    summary: "Persist defaults and secrets to the user config file.",
    usage: ["co-maintainer set [options]"],
    groups: [
      AI_FLAGS,
      GITHUB_FLAGS,
      {
        title: "Server",
        flags: [
          {
            name: "github-app-id",
            value: "ID",
            description: "The GitHub App id.",
          },
          {
            name: "github-app-private-key",
            value: "PEM",
            description: "The GitHub App private key.",
          },
          {
            name: "github-app-private-key-file",
            value: "PATH",
            description: "Read the private key from a file.",
          },
          {
            name: "github-app-private-key-path",
            value: "PATH",
            description: "Store the key's path only, never its contents.",
          },
          {
            name: "github-webhook-secret",
            value: "SECRET",
            description: "The webhook HMAC secret.",
          },
          {
            name: "github-oauth-client-id",
            value: "ID",
            description: "The GitHub OAuth app client id.",
          },
          {
            name: "github-oauth-client-secret",
            value: "SECRET",
            description: "The GitHub OAuth app client secret.",
          },
          {
            name: "github-oauth-allowed-user",
            value: "LOGIN",
            description: "The only GitHub user allowed to sign in.",
          },
          {
            name: "remote-host",
            value: "URL",
            description: "The remote review server.",
          },
          {
            name: "remote-token",
            value: "TOKEN",
            description: "The remote review token.",
          },
          {
            name: "remote-byok-policy",
            value: "off|allow|require",
            default: "off",
            description: "Whether a remote client may send its own AI key.",
          },
          {
            name: "remote-client-tools-policy",
            value: "off|on",
            default: "off",
            description:
              "Whether a remote review offers the model the tools a client declares, such as its own MCP servers.",
          },
          {
            name: "remote-byok",
            value: "KEY",
            description: "Your own AI key to send with a remote review.",
          },
          {
            name: "remote-byok-default",
            value: "on|off",
            default: "off",
            description:
              "Send remote-byok on every --remote review by default.",
          },
          {
            name: "review-policy",
            value: "everyone|trusted-auto|on-request-only",
            description: "The review policy new repositories start with.",
          },
          {
            name: "review-policy-file",
            value: "PATH",
            description:
              "Read a custom review policy from a JSON file and use it as that default.",
          },
          {
            name: "repo",
            value: "owner/repo",
            description:
              "Write the repository-scoped settings below to this repository instead of the global config.",
          },
          {
            name: "gh-concurrent",
            value: "N",
            description:
              "Server default for concurrent GitHub calls. With --repo, the repository override. 1..16.",
          },
          {
            name: "ai-concurrent",
            value: "N",
            description:
              "Server default for concurrent AI calls. With --repo, the repository override. 1..16.",
          },
          {
            name: "review-references",
            value: "on|off",
            description:
              "Show the rules each finding rests on in review comments and the terminal. Needs --repo.",
          },
          {
            name: "review-system-prompt",
            value: "TEXT",
            description:
              "A repository's own review instructions. Needs --repo. Empty clears it.",
          },
          {
            name: "review-system-prompt-max-chars",
            value: "N",
            description:
              "Cap the repository's review instructions in characters. Needs --repo. 0 or -1 means no limit.",
          },
          {
            name: "diagram-runtime",
            value: "mermaid|plantuml|plantuml-server",
            default: "mermaid",
            description:
              "The diagram language for a repository's reviews, including App reviews. Needs --repo.",
          },
          {
            name: "plantuml-server",
            value: "URL",
            default: "https://www.plantuml.com",
            description:
              "The PlantUML server for plantuml-server. An http or https URL. Needs --repo.",
          },
          {
            name: "plantuml-output-format",
            value: "svg|png",
            default: "svg",
            description: "The image format for plantuml-server. Needs --repo.",
          },
          {
            name: "review-read-diff-max-chars",
            value: "N",
            default: "20000",
            description:
              "The most characters one read-full-diff answer returns in a review of this repository. Needs --repo. 0 or -1 means no limit.",
          },
          {
            name: "review-tool-result-max-chars",
            value: "N",
            default: "8000",
            description:
              "The most characters one review tool result returns before it is cut. Codegraph and read-full-diff are not cut by it. Needs --repo. 0 or -1 means no limit.",
          },
          {
            name: "review-tool-budget-chars",
            value: "N",
            default: "40000",
            description:
              "Tool result characters per review. Once they are spent, later tool calls get no answer. Codegraph is not counted. Needs --repo. 0 or -1 means no limit.",
          },
          {
            name: "review-search-max-context-lines",
            value: "N",
            default: "3",
            description:
              "The most lines search-non-code returns around a match. Needs --repo. 0 or -1 means no limit.",
          },
          {
            name: "review-diff-max-chars",
            value: "N",
            default: "240000",
            description:
              "The DIFF section of a review prompt, in characters. Raise it for a model with a large context. Needs --repo. 0 or -1 means no limit.",
          },
          {
            name: "review-file-patch-max-chars",
            value: "N",
            default: "12000",
            description:
              "Where one file's patch is cut and marked partial. Needs --repo. 0 or -1 means no limit.",
          },
          {
            name: "mcp-config",
            value: "PATH",
            description:
              "Read the repository's MCP servers from this JSON file and store them. Reviews offer their listed read-only tools to the model. Needs --repo. Refused when CM_MCP_DISABLED=1.",
          },
          {
            name: "mcp-allow-forks",
            value: "true|false",
            default: "false",
            description:
              "Offer MCP tools in serve reviews of pull requests from forks. Needs --repo.",
          },
          {
            name: "guide-full-every",
            value: "N",
            default: "10",
            description:
              "Every N-th sync whose input changed rewrites the review guide in full, the others edit it. 1 always rewrites, 0 never after init. Needs --repo.",
          },
          {
            name: "companions",
            value: "owner/repo,...",
            description:
              "Repositories whose pull requests a review of this one may read as companions, up to 5. A Companion: owner/repo#N line in the pull request body names one, otherwise an open pull request with the same branch name is used. Needs --repo.",
          },
          {
            name: "review-blocking",
            value: "model|severity",
            default: "model",
            description:
              "How a review decides a blocking finding. With --repo, for that repository.",
          },
          {
            name: "review-event",
            value: "auto|comment",
            default: "auto",
            description:
              "How the App posts a review: approve or request changes, or comment only. With --repo, for that repository.",
          },
          {
            name: "ai-timeout-minutes",
            value: "N",
            default: "15",
            description:
              "How long one AI request may wait for the provider before it fails, in minutes.",
          },
          {
            name: "global-reasoning-effort",
            value: "none|low|default|high|xhigh|max",
            default: "high",
            description:
              "How much the model reasons in every AI job. default sends no reasoning field and leaves it to the provider.",
          },
          {
            name: "codegraph-version",
            value: "SEMVER",
            description:
              "The pinned codegraph version, overriding the built-in one. For a security fix without a release.",
          },
          {
            name: "password",
            value: "TEXT",
            description: "Replace the dashboard password.",
          },
          {
            name: "extension-rerun-on-restart",
            value: "true|false",
            default: "true",
            description:
              "Run an extension again when co-maintainer restarted while it ran. A registration's --rerun-on-restart wins.",
          },
          {
            name: "disable-auth",
            value: "password|github",
            description:
              "Turn a sign-in method off. Refused when it would leave no way in.",
          },
          {
            name: "enable-auth",
            value: "password|github",
            description:
              "Turn a sign-in method on. A running serve picks it up on the next request.",
          },
          {
            name: "webhook-url",
            value: "URL",
            description:
              "The public webhook address GitHub posts to. --webhook-url on serve and CM_WEBHOOK_URL win over it.",
          },
          {
            name: "max-concurrent-jobs",
            value: "N",
            description: "How many server jobs run at once.",
          },
          {
            name: "remote-sync-timeout-seconds",
            value: "N",
            description: "How long a remote review waits for one sync.",
          },
          {
            name: "max-concurrent-remote-reviews-per-token",
            value: "N",
            description: "Remote reviews one token may run at once.",
          },
          {
            name: "remote-tool-output-max-chars",
            value: "N",
            description:
              "The longest client tool result a remote review keeps.",
          },
          {
            name: "no-verify",
            description: "Do not check the key and model against the provider.",
          },
          {
            name: "unset",
            value: "NAME",
            description: "Remove a stored value.",
          },
        ],
      },
    ],
    examples: [
      "co-maintainer set --ai=openrouter --ai-key=... --low-model=... --high-model=...",
      "co-maintainer set --remote-host=https://review.example.com --remote-token=...",
      "co-maintainer set --repo=owner/repo --review-system-prompt='Focus on the parser.'",
      "co-maintainer set --repo=owner/repo --diagram-runtime=plantuml-server",
      "co-maintainer set --repo=owner/repo --mcp-config=./mcp.json",
      "co-maintainer set --repo=owner/app --companions=owner/docs,owner/vscode-ext",
      "co-maintainer set --unset=token",
    ],
  },
  {
    name: "serve",
    summary: "Run the dashboard, the webhook and the job worker.",
    usage: ["co-maintainer serve --port=N [options]"],
    groups: [
      {
        title: "Server",
        flags: [
          {
            name: "port",
            value: "N",
            description: "The port to listen on. Required.",
          },
          {
            name: "webhook-url",
            value: "URL",
            description: "The public webhook URL. Defaults to localhost.",
          },
          {
            name: "password",
            value: "TEXT",
            description:
              "Replace the dashboard password on every start, which signs out every session. Leave it out of a service file and change the password in Settings instead.",
          },
          {
            name: "disable-auth",
            value: "password|github",
            description:
              "Force a sign-in method off for this run, whatever Settings says.",
          },
          {
            name: "enable-auth",
            value: "password|github",
            description:
              "Force a sign-in method on for this run, whatever Settings says.",
          },
          {
            name: "trust-proxy",
            description: "Trust x-forwarded-for and x-forwarded-proto.",
          },
          {
            name: "inject-500",
            description: "Return 500 for mutating requests. Debugging only.",
          },
        ],
      },
      SERVE_OUTPUT_FLAGS,
    ],
    examples: ["co-maintainer serve --port=5000"],
  },
  EXTENSION_COMMAND,
  {
    name: "rollback",
    summary:
      "Go back to the version before the last upgrade, restoring its data.",
    usage: ["co-maintainer rollback [--yes]"],
    groups: [
      {
        title: "Rollback",
        flags: [
          {
            name: "yes",
            description:
              "Skip the confirmation. Needed when there is no terminal.",
          },
        ],
      },
    ],
    examples: ["co-maintainer rollback", "co-maintainer rollback --yes"],
  },
  {
    name: "version",
    summary: "Print the version.",
    usage: ["co-maintainer version"],
    groups: [],
    examples: ["co-maintainer version"],
  },
];

/** Every name a command answers to, including hidden aliases. */
export function allNames(): string[] {
  const names: string[] = [];
  for (const command of COMMANDS) {
    names.push(command.name, ...(command.aliases ?? []));
  }
  return names;
}

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find(
    (command) => command.name === name || command.aliases?.includes(name),
  );
}

/** Commands listed in the global help. A hidden alias or command is resolvable
 * but invisible. */
export function visibleCommands(): CommandSpec[] {
  return COMMANDS.filter((command) => !command.hidden);
}

/** The visible command names in help order. Tests and scripts iterate this
 * instead of repeating the list, so a new command cannot be forgotten in one
 * place and present in another. */
export function visibleCommandNames(): string[] {
  return visibleCommands().map((command) => command.name);
}

/** Levenshtein distance, iterative and allocation-light: the help path runs it
 * on every unknown token, and the strings are short. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** The closest candidate within `maxDistance`, or undefined. Ties keep the
 * first candidate, which is the declaration order in `COMMANDS`. */
export function closest(
  input: string,
  candidates: string[],
  maxDistance = 2,
): string | undefined {
  let best: string | undefined;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = levenshtein(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= maxDistance ? best : undefined;
}

/** `prob` becomes `Unknown command: prob. Did you mean probe?`. */
export function unknownCommandMessage(input: string): string {
  const suggestion = closest(input, allNames());
  return suggestion
    ? `Unknown command: ${input}. Did you mean ${suggestion}?`
    : `Unknown command: ${input}`;
}

/** `--jsno` becomes `Unknown option: --jsno. Did you mean --json?`.
 *
 * When `command` is given the suggestion is drawn only from that command's own
 * flags, so `review --review-blocking` cannot suggest a flag only `set` takes
 * (N01, found in the beta run). Without a command the whole surface is fair
 * game, which is all `view` and generic parsers need. */
export function unknownOptionMessage(input: string, command?: string): string {
  const flag = input.replace(/^--?/, "").split("=")[0] ?? "";
  const scoped = command === undefined ? undefined : findCommand(command);
  const candidates = scoped
    ? scoped.groups.flatMap((group) => group.flags.map((spec) => spec.name))
    : COMMANDS.flatMap((command) =>
        command.groups.flatMap((group) => group.flags.map((spec) => spec.name)),
      );
  const suggestion = closest(flag, [...new Set(candidates)]);
  return suggestion
    ? `Unknown option: ${input}. Did you mean --${suggestion}?`
    : `Unknown option: ${input}`;
}

function renderFlags(groups: FlagGroup[], lines: string[]): void {
  for (const group of groups) {
    if (group.flags.length === 0) continue;
    lines.push("");
    lines.push(`${group.title}:`);
    for (const flag of group.flags) {
      const head = `  --${flag.name}${flag.value ? `=${flag.value}` : ""}`;
      const meta =
        flag.default !== undefined ? ` (default: ${flag.default})` : "";
      // An option too long for the 42-column gutter gets its own line, so
      // its last value never runs into the description.
      if (head.length + 2 > 42) {
        lines.push(head);
        lines.push(`${" ".repeat(42)}${flag.description}${meta}`);
      } else {
        lines.push(`${head.padEnd(42)}${flag.description}${meta}`);
      }
    }
  }
}

/** The global help: every visible command with its one-line summary. */
export function renderGlobalHelp(): string {
  const lines: string[] = [];
  lines.push("Usage: co-maintainer <command> owner/repo [options]");
  lines.push("");
  lines.push("Commands:");
  for (const command of visibleCommands()) {
    lines.push(`  ${command.name.padEnd(10)}${command.summary}`);
  }
  lines.push("");
  lines.push("Run co-maintainer help <command> for details.");
  return lines.join("\n");
}

/** One command's help: usage, flags grouped, examples, docs link. */
export function renderCommandHelp(name: string): string | undefined {
  const command = findCommand(name);
  if (!command) return undefined;
  const lines: string[] = [];
  lines.push(`co-maintainer ${command.name}: ${command.summary}`);
  lines.push("");
  lines.push("Usage:");
  for (const usage of command.usage) lines.push(`  ${usage}`);
  renderFlags(command.groups, lines);
  if (command.examples.length > 0) {
    lines.push("");
    lines.push("Examples:");
    for (const example of command.examples) lines.push(`  ${example}`);
  }
  if (command.docs) {
    lines.push("");
    lines.push(`Docs: ${command.docs}`);
  }
  return lines.join("\n");
}

/** A Markdown table cell cannot hold a raw `|`, or the column splits. Escaping
 * it keeps values such as `--auth=gh|pat` in one cell. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** The registry as markdown, so the command reference can be built from
 * the same data the runtime help uses. */
export function registryToMarkdown(): string {
  const lines: string[] = [];
  for (const command of visibleCommands()) {
    lines.push(`## \`co-maintainer ${command.name}\``);
    lines.push("");
    lines.push(command.summary);
    lines.push("");
    lines.push("```");
    for (const usage of command.usage) lines.push(usage);
    lines.push("```");
    for (const group of command.groups) {
      if (group.flags.length === 0) continue;
      lines.push("");
      lines.push(`### ${group.title}`);
      lines.push("");
      lines.push("| Flag | Default | Description |");
      lines.push("|---|---|---|");
      for (const flag of group.flags) {
        const flagCell = flag.value
          ? `--${flag.name}=${flag.value}`
          : `--${flag.name}`;
        lines.push(
          `| \`${cell(flagCell)}\` | ${cell(flag.default ?? "")} | ${cell(flag.description)} |`,
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
