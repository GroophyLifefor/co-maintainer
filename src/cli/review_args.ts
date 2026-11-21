import { setRemoteDiagnostics } from "../remote/http.ts";
import { parseArgs, setCliInteractive } from "./args.ts";
import { die } from "./error.ts";
import { readConfig } from "../config.ts";
import { readTextFile } from "../util/runtime.ts";
import {
  checkReviewSystemPrompt,
  reviewSystemPromptLimit,
} from "../review/system_prompt.ts";
import { type IntentLoad, loadIntentFlag } from "./review_intent.ts";
import { withFlagValues } from "./review_with.ts";
import type { Options } from "../types.ts";

export type ReviewMode = "local" | "remote" | "pr";

type ReviewFlags = {
  json: boolean;
  remote: boolean;
  disableCodegraph: boolean;
  allowToolInstall: boolean;
  fresh: boolean;
  toBranch?: string;
  branch?: string;
  repoOverride?: string;
  remakeBeforeReview: boolean;
  /** `--remote-host` override for this run only. */
  remoteHost?: string;
  /** `--remote-token` override for this run only. */
  remoteToken?: string;
  /** `--remote-byok` (`true`) / `--no-remote-byok` (`false`) for this run
   * only. Unset means "use the configured default". */
  remoteByok?: boolean;
  /** `--output=github`: workflow commands and a job summary instead of prose.
   */
  output?: "github";
  /** `--system-prompt-file`: a file whose contents are appended to the
   * custom review section for this run only. */
  systemPromptFile?: string;
  /** `--system-prompt-override-file`: a file whose contents replace the
   * repository's custom review section for this run only. */
  systemPromptOverrideFile?: string;
  /** `--intent-file`: a file, or `-` for standard input, that says what the
   * change is for. Context for the prompt, never a rule. */
  intentFile?: string;
  /** `--with=PATH[@BRANCH]`, each given: companion checkouts read as
   * context. */
  with?: string[];
  /** `--range=<before>..<after>`: review a push instead of the working tree
   * (commit watch). Only with `--remote`. */
  range?: { before: string; after: string };
  /** `--timeout-minutes`: how long a `--range` review waits for the server
   * before it leaves the result to the dashboard. */
  timeoutMinutes?: number;
  /** `--include-extension-markdowns`: keep each extension's `markdown` in
   * `--json`. */
  includeExtensionMarkdowns?: boolean;
};

export type ReviewCliArgs =
  | ({ mode: "pr"; options: Options; intentLoad?: IntentLoad } & ReviewFlags)
  | ({ mode: "local"; rawArgs: string[] } & ReviewFlags)
  | ({ mode: "remote"; rawArgs: string[] } & ReviewFlags);

/** `before..after`. Each side is any revision git can resolve. */
function parseRange(value: string | undefined): ReviewFlags["range"] {
  if (value === undefined) return undefined;
  // A side may hold single dots (v0.6.9), never two in a row, so `..` splits
  // once and `a...b` is refused.
  const sides = value.split("..");
  const valid = (side: string | undefined): side is string =>
    Boolean(side) && /^[^\s-][^\s]*$/.test(side!) && !/^\.|\.$/.test(side!);
  if (sides.length !== 2 || !valid(sides[0]) || !valid(sides[1])) {
    die("--range must look like <before>..<after>");
  }
  return { before: sides[0], after: sides[1] };
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 360) {
    die("--timeout-minutes must be a number of minutes between 1 and 360");
  }
  return minutes;
}

function reviewFlags(rest: string[]): ReviewFlags {
  const text = (name: string) =>
    rest.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  // `--remake-before-review` is the 0.4.13 spelling. Both names mean the same
  // thing, and only the new one is documented.
  const syncBeforeReview = rest.some(
    (arg) => arg === "--sync-before-review" || arg === "--remake-before-review",
  );
  const remoteByokOn = rest.includes("--remote-byok");
  const remoteByokOff = rest.includes("--no-remote-byok");
  for (const arg of rest) {
    if (arg === "--codegraph") {
      die("Unknown option: --codegraph");
    }
    if (arg === "--remote" && syncBeforeReview) {
      die("--sync-before-review cannot be used with --remote");
    }
  }
  if (remoteByokOn && remoteByokOff) {
    die("--remote-byok and --no-remote-byok cannot both be used");
  }
  const output = text("output");
  if (output !== undefined && output !== "github") {
    die("--output must be: github");
  }
  if (output !== undefined && rest.includes("--json")) {
    die("--output=github cannot be used with --json");
  }
  return {
    json: rest.includes("--json"),
    remote: rest.includes("--remote"),
    disableCodegraph: rest.includes("--disable-codegraph"),
    allowToolInstall: rest.includes("--allow-tool-install"),
    fresh: rest.includes("--fresh"),
    toBranch: text("to-branch"),
    branch: text("branch"),
    repoOverride: text("repo"),
    remakeBeforeReview: syncBeforeReview,
    remoteHost: text("remote-host"),
    remoteToken: text("remote-token"),
    remoteByok: remoteByokOn ? true : remoteByokOff ? false : undefined,
    output,
    systemPromptFile: text("system-prompt-file"),
    systemPromptOverrideFile: text("system-prompt-override-file"),
    intentFile: text("intent-file"),
    with: withFlagValues(rest),
    range: parseRange(text("range")),
    timeoutMinutes: parseTimeout(text("timeout-minutes")),
    includeExtensionMarkdowns: rest.includes("--include-extension-markdowns"),
  };
}

const LOCAL_ONLY_FLAGS = new Set([
  "--json",
  "--remote",
  "--disable-codegraph",
  "--allow-tool-install",
  "--fresh",
  "--remake-before-review",
  "--sync-before-review",
  "--remote-byok",
  "--no-remote-byok",
  "--include-extension-markdowns",
]);

/** Strip local-only flags before `parseArgs` for PR-style options. */
export function filterReviewConfigArgs(raw: string[]): string[] {
  return raw.filter((arg) => {
    if (LOCAL_ONLY_FLAGS.has(arg)) return false;
    if (
      arg.startsWith("--to-branch=") ||
      arg.startsWith("--branch=") ||
      arg.startsWith("--repo=") ||
      arg.startsWith("--remote-host=") ||
      arg.startsWith("--remote-token=") ||
      arg.startsWith("--output=") ||
      arg.startsWith("--system-prompt-file=") ||
      arg.startsWith("--system-prompt-override-file=") ||
      arg.startsWith("--intent-file=") ||
      arg.startsWith("--with=") ||
      arg.startsWith("--range=") ||
      arg.startsWith("--timeout-minutes=")
    ) {
      return false;
    }
    return true;
  });
}

/** The repository's custom-prompt cap, read from config.json. */
export function reviewSystemPromptLimitFor(repo: string): number | null {
  return reviewSystemPromptLimit(readConfig().repos?.[repo]);
}

/** Reads the per-run system-prompt files and checks each against the
 * repository's cap. `die`s naming the flag when a file cannot be read or is
 * over the cap. */
export async function loadReviewSystemPromptFlags(
  cli: Pick<ReviewFlags, "systemPromptFile" | "systemPromptOverrideFile">,
  limit: number | null,
): Promise<{ add?: string; override?: string }> {
  const load = async (flag: string, path: string): Promise<string> => {
    let text: string;
    try {
      text = await readTextFile(path);
    } catch (error) {
      die(`${flag}: could not read ${path}: ${String(error)}`);
    }
    const problem = checkReviewSystemPrompt(text, limit);
    if (problem) die(`${flag}: ${problem}`);
    return text;
  };
  const result: { add?: string; override?: string } = {};
  if (cli.systemPromptFile) {
    result.add = await load("--system-prompt-file", cli.systemPromptFile);
  }
  if (cli.systemPromptOverrideFile) {
    result.override = await load(
      "--system-prompt-override-file",
      cli.systemPromptOverrideFile,
    );
  }
  return result;
}

/** Every flag a remote review reads. The rest were taken and dropped
 * without a word before, a typo included. */
const REMOTE_FLAGS = new Set([
  "remote",
  "remote-host",
  "remote-token",
  "remote-byok",
  "no-remote-byok",
  "json",
  "output",
  "debug",
  "log-time",
  "env",
  "branch",
  "repo",
  "to-branch",
  "fresh",
  "range",
  "timeout-minutes",
  "system-prompt-file",
  "system-prompt-override-file",
  "intent-file",
  "with",
  "disable-codegraph",
  "allow-tool-install",
  "include-extension-markdowns",
]);

/** Settings that belong to the server for a remote review. */
const SERVER_OWNED = new Set([
  "ai",
  "ai-key",
  "token",
  "low-model",
  "high-model",
  "auth",
  "github-pat",
  "improve-matrix",
]);

function checkRemoteFlags(args: string[]): void {
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2).split("=")[0]!;
    if (REMOTE_FLAGS.has(name)) continue;
    if (SERVER_OWNED.has(name)) {
      die(
        `--${name} cannot be used with --remote. The server reviews with its own settings for the repository.`,
      );
    }
    die(`Unknown option for review --remote: ${arg.split("=")[0]}`);
  }
}

/** Parses `co-maintainer review` after the `review` token. */
export async function parseReviewArgs(args: string[]): Promise<ReviewCliArgs> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = reviewFlags(args);
  // Remote review runs on the server's provider, so the experimental local
  // provider has nothing to attach to.
  if (flags.remote && args.includes("--experimental-siwc")) {
    die("--experimental-siwc cannot be used with --remote");
  }
  // `--remote-host` / `--remote-token` only mean something together with
  // `--remote`. Silently dropping them is exactly the kind of surprise to avoid.
  if ((flags.remoteHost || flags.remoteToken) && !flags.remote) {
    die("--remote-host and --remote-token require --remote");
  }
  if (flags.remoteByok !== undefined && !flags.remote) {
    die("--remote-byok requires --remote");
  }
  // The server reviews with the repository's saved diagram settings, so a flag
  // here would be dropped without a word.
  const diagramFlag = args.find((arg) =>
    /^--(diagram-runtime|plantuml-server|plantuml-output-format)(=|$)/.test(
      arg,
    ),
  );
  if (flags.remote && diagramFlag) {
    die(
      `${diagramFlag.split("=")[0]} cannot be used with --remote. ` +
        "The server uses the diagram settings saved for the repository.",
    );
  }
  if (flags.range && !flags.remote) {
    die("--range requires --remote");
  }
  if (flags.timeoutMinutes !== undefined && !flags.range) {
    die("--timeout-minutes requires --range");
  }
  if (flags.range && flags.intentFile !== undefined) {
    die("--intent-file is not supported with --range");
  }
  if (flags.range && flags.with?.length) {
    die("--with is not supported with --range");
  }
  if (flags.range && (flags.fresh || flags.toBranch)) {
    die("--range cannot be used with --fresh or --to-branch");
  }
  // A push review sends no review instructions, so the files would be read
  // and dropped without a word.
  if (
    flags.range &&
    (flags.systemPromptFile !== undefined ||
      flags.systemPromptOverrideFile !== undefined)
  ) {
    die(
      "--system-prompt-file and --system-prompt-override-file are not supported with --range. Save the instructions for the repository with set --repo --review-system-prompt instead.",
    );
  }
  // `--json` must never prompt. `parseArgs` only receives the
  // filtered args, and `--json` is stripped before it sees them, so the flag
  // has to be applied here rather than after the parse returns.
  setCliInteractive(!flags.json);
  const isPr =
    positional.length >= 2 &&
    /^[^/]+\/[^/]+$/.test(positional[0]!) &&
    /^\d+$/.test(positional[1]!);
  if (isPr) {
    if (flags.remoteHost || flags.remoteToken) {
      die("--remote-host is only for remote review without a PR number");
    }
    if (flags.remoteByok !== undefined) {
      die("--remote-byok is only for remote review without a PR number");
    }
    const options = await parseArgs([
      "review",
      positional[0],
      positional[1],
      ...filterReviewConfigArgs(args),
    ]);
    if (flags.remote)
      die("--remote is only for local review without a PR number");
    if (flags.remakeBeforeReview) {
      die("--sync-before-review is not supported for PR review");
    }
    const promptFlags = await loadReviewSystemPromptFlags(
      flags,
      reviewSystemPromptLimitFor(options.repo),
    );
    const intentLoad = await loadIntentFlag(
      flags.intentFile,
      reviewSystemPromptLimitFor(options.repo),
    );
    return {
      mode: "pr",
      options: {
        ...options,
        useCodegraph: flags.disableCodegraph ? false : true,
        allowToolInstall: flags.allowToolInstall,
        reviewSystemPromptAdd: promptFlags.add,
        reviewSystemPromptOverride: promptFlags.override,
        reviewIntent: intentLoad.intent?.text,
      },
      intentLoad,
      ...flags,
    };
  }
  if (positional.length === 0) {
    if (flags.remote) {
      checkRemoteFlags(args);
      setRemoteDiagnostics({
        debug: args.includes("--debug"),
        logTime: args.includes("--log-time"),
      });
      return { mode: "remote", rawArgs: args, ...flags };
    }
    return { mode: "local", rawArgs: args, ...flags };
  }
  die(
    "Usage: co-maintainer review [options]\n" +
      "       co-maintainer review owner/repo PR_NUMBER [options]",
  );
}
