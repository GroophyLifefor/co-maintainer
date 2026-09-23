/** The command registry (CORE-20).
 *
 * One place that knows every command, its aliases, its usage lines, its flags
 * and its examples. Everything the user reads as help is rendered from here,
 * so a flag cannot drift out of the help and a command cannot be documented
 * twice with different wording. It is also the source CORE-81 will export to
 * the command reference, which is why it is data rather than template strings.
 */

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
  ],
};

const AI_FLAGS: FlagGroup = {
  title: "AI",
  flags: [
    {
      name: "ai",
      value: "none|openrouter|hetzner",
      default: "none",
      description: "Which provider writes the review.",
    },
    { name: "token", value: "KEY", description: "The provider API key." },
    {
      name: "ai-key",
      value: "KEY",
      description: "The same key as --token, named for what it is.",
    },
    {
      name: "low-model",
      value: "ID",
      default: "openai/gpt-oss-120b",
      description: "Model for extraction work.",
    },
    {
      name: "high-model",
      value: "ID",
      default: "openai/gpt-5.6-luna",
      description: "Model for the review itself.",
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
      {
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
              "Read only the pull requests that changed the requested files.",
          },
        ],
      },
      AI_FLAGS,
      GITHUB_FLAGS,
      OUTPUT_FLAGS,
      {
        title: "Performance",
        flags: [
          {
            name: "gh-concurrent",
            value: "N",
            default: "1",
            description: "Concurrent gh calls.",
          },
          {
            name: "ai-concurrent",
            value: "N",
            default: "3",
            description: "Concurrent AI calls.",
          },
          {
            name: "improve-matrix",
            value: "N",
            default: "1",
            description: "How many improvement passes to run.",
          },
        ],
      },
    ],
    examples: [
      "co-maintainer init owner/repo --include-codebase --include-pull-requests",
      "co-maintainer init owner/repo --include-codebase --ai=openrouter --token=...",
    ],
  },
  {
    name: "sync",
    // `remake` is the 0.4.13 spelling. It still runs the same handler but is
    // not advertised, so nothing the user reads says "remake" (CORE-21).
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
      AI_FLAGS,
      GITHUB_FLAGS,
      OUTPUT_FLAGS,
    ],
    examples: ["co-maintainer sync owner/repo --include-codebase"],
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
      AI_FLAGS,
      GITHUB_FLAGS,
      OUTPUT_FLAGS,
    ],
    examples: [
      "co-maintainer review owner/repo 42 --json",
      "co-maintainer review --json --disable-codegraph",
      "co-maintainer review --remote --json",
      "co-maintainer review --remote --remote-host=https://review.example.com --remote-token=cmr_...",
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
            name: "review-blocking",
            value: "model|severity",
            default: "model",
            description: "How a review decides a blocking finding.",
          },
          {
            name: "password",
            value: "TEXT",
            description: "Replace the dashboard password.",
          },
          {
            name: "disable-auth",
            value: "password",
            description: "Turn the dashboard password off.",
          },
          {
            name: "enable-auth",
            value: "github",
            description: "Turn GitHub sign-in on.",
          },
          {
            name: "no-verify",
            description: "Do not check the key and model against OpenRouter.",
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
            description: "Set the dashboard password on first start.",
          },
          {
            name: "disable-auth",
            value: "password",
            description: "Turn the dashboard password off.",
          },
          {
            name: "enable-auth",
            value: "github",
            description: "Turn GitHub sign-in on.",
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
      OUTPUT_FLAGS,
    ],
    examples: ["co-maintainer serve --port=5000"],
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

/** `--jsno` becomes `Unknown option: --jsno. Did you mean --json?`. */
export function unknownOptionMessage(input: string): string {
  const flag = input.replace(/^--?/, "").split("=")[0] ?? "";
  const candidates = COMMANDS.flatMap((command) =>
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
      lines.push(`${head.padEnd(42)}${flag.description}${meta}`);
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
  lines.push(`co-maintainer ${command.name} — ${command.summary}`);
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

/** The registry as markdown, so CORE-81 can build the command reference from
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
          `| \`${flagCell}\` | ${flag.default ?? ""} | ${flag.description} |`,
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
