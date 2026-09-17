import { parseArgs } from "./args.ts";
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
};

export type ReviewCliArgs =
  | { mode: "pr"; options: Options } & ReviewFlags
  | { mode: "local"; rawArgs: string[] } & ReviewFlags
  | { mode: "remote"; rawArgs: string[] } & ReviewFlags;

function die(message: string): never {
  throw new Error(message);
}

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
} {
  const text = (name: string) =>
    rest.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  for (const arg of rest) {
    if (arg === "--codegraph") {
      die("Unknown option: --codegraph");
    }
    if (arg === "--remote" && rest.some((r) => r === "--remake-before-review")) {
      die("--remake-before-review cannot be used with --remote");
    }
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
    remakeBeforeReview: rest.includes("--remake-before-review"),
  };
}

const LOCAL_ONLY_FLAGS = new Set([
  "--json",
  "--remote",
  "--disable-codegraph",
  "--allow-tool-install",
  "--fresh",
  "--remake-before-review",
]);

/** Strip local-only flags before `parseArgs` for PR-style options. */
export function filterReviewConfigArgs(raw: string[]): string[] {
  return raw.filter((arg) => {
    if (LOCAL_ONLY_FLAGS.has(arg)) return false;
    if (
      arg.startsWith("--to-branch=") ||
      arg.startsWith("--branch=") ||
      arg.startsWith("--repo=")
    ) {
      return false;
    }
    return true;
  });
}

/** Parses `co-maintainer review` after the `review` token (plan §8.1). */
export function parseReviewArgs(args: string[]): ReviewCliArgs {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = reviewFlags(args);
  const isPr =
    positional.length >= 2 &&
    /^[^/]+\/[^/]+$/.test(positional[0]!) &&
    /^\d+$/.test(positional[1]!);
  if (isPr) {
    const options = parseArgs([
      "review",
      positional[0],
      positional[1],
      ...filterReviewConfigArgs(args),
    ]);
    if (flags.remote) die("--remote is only for local review without a PR number");
    if (flags.remakeBeforeReview) {
      die("--remake-before-review is not supported for PR review");
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
