import { parseArgs, setCliInteractive } from "./args.ts";
import { die } from "./error.ts";
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
  /** `--remote-host` override for this run only (CORE-25). */
  remoteHost?: string;
  /** `--remote-token` override for this run only (CORE-25). */
  remoteToken?: string;
  /** `--remote-byok` (`true`) / `--no-remote-byok` (`false`) for this run
   * only (CORE-111). Unset means "use the configured default". */
  remoteByok?: boolean;
  /** `--output=github`: workflow commands and a job summary instead of prose
   * (CORE-130). */
  output?: "github";
};

export type ReviewCliArgs =
  | ({ mode: "pr"; options: Options } & ReviewFlags)
  | ({ mode: "local"; rawArgs: string[] } & ReviewFlags)
  | ({ mode: "remote"; rawArgs: string[] } & ReviewFlags);

function reviewFlags(rest: string[]): {
  json: boolean;
  remote: boolean;
  disableCodegraph: boolean;
  allowToolInstall: boolean;
  fresh: boolean;
  toBranch?: string;
  branch?: string;
  repoOverride?: string;
  remakeBeforeReview: boolean;
  remoteHost?: string;
  remoteToken?: string;
  remoteByok?: boolean;
  output?: "github";
} {
  const text = (name: string) =>
    rest.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  // `--remake-before-review` is the 0.4.13 spelling; both names mean the same
  // thing, and only the new one is documented (CORE-21).
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
      arg.startsWith("--output=")
    ) {
      return false;
    }
    return true;
  });
}

/** Parses `co-maintainer review` after the `review` token (plan §8.1). */
export async function parseReviewArgs(args: string[]): Promise<ReviewCliArgs> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = reviewFlags(args);
  // `--remote-host` / `--remote-token` only mean something together with
  // `--remote`; silently dropping them is exactly the F33 surprise (CORE-25).
  if ((flags.remoteHost || flags.remoteToken) && !flags.remote) {
    die("--remote-host and --remote-token require --remote");
  }
  if (flags.remoteByok !== undefined && !flags.remote) {
    die("--remote-byok requires --remote");
  }
  // `--json` must never prompt (plan §8.7). `parseArgs` only receives the
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
    return {
      mode: "pr",
      options: {
        ...options,
        useCodegraph: flags.disableCodegraph ? false : true,
      },
      ...flags,
    };
  }
  if (positional.length === 0) {
    if (flags.remote) return { mode: "remote", rawArgs: args, ...flags };
    return { mode: "local", rawArgs: args, ...flags };
  }
  die(
    "Usage: co-maintainer review [options]\n" +
      "       co-maintainer review owner/repo PR_NUMBER [options]",
  );
}
