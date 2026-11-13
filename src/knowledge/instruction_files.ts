/** Which files on the default branch are agent instruction files, and how
 * many of them a build reads.
 *
 * `--agent-instructions` is a JavaScript regex matched against each full path.
 * The matches are read in full, outside the codebase file cap, but a
 * repository with hundreds of them must not turn one synthesis call into a
 * book, so there is a cap on the count and on the total size. */

import { CliError, EXIT_USAGE } from "../cli/error.ts";

/** The default `--agent-instructions`: every `AGENTS.md`, at any depth. */
export const DEFAULT_AGENT_INSTRUCTIONS = "(^|/)AGENTS\\.md$";

/** The default `--agent-instructions-max-chars`. */
export const DEFAULT_AGENT_INSTRUCTIONS_MAX_CHARS = 6000;

/** At most this many instruction files are read. */
export const MAX_INSTRUCTION_FILES = 50;

/** At most this many characters of instruction files are read in total. */
export const MAX_INSTRUCTION_CHARS = 400_000;

/** The parse error for a pattern, or `null` when it compiles. */
export function agentInstructionsError(source: string): string | null {
  try {
    new RegExp(source);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The regex a build uses, or `null` when the feature is off. Unset takes the
 * default and a blank value turns the feature off. */
export function agentInstructionsPattern(
  source: string | undefined,
): RegExp | null {
  const value = source ?? DEFAULT_AGENT_INSTRUCTIONS;
  if (value.trim() === "") return null;
  const error = agentInstructionsError(value);
  // A flag value is checked when it is parsed, so this is a saved value that
  // was edited by hand. Name it, and exit as a usage error.
  if (error) {
    throw new CliError(
      "usage",
      `The saved agentInstructions pattern is not a valid regular expression: ${error}`,
      "Pass --agent-instructions=REGEX to sync to replace it.",
      EXIT_USAGE,
    );
  }
  return new RegExp(value);
}

/** The cap on `INSTRUCTIONS.md`, or `null` for no limit. */
export function agentInstructionsLimit(raw: number | undefined): number | null {
  if (raw === undefined) return DEFAULT_AGENT_INSTRUCTIONS_MAX_CHARS;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

function depth(path: string): number {
  return path.split("/").length;
}

/** The matching paths in reading order: root files first, then deeper ones,
 * alphabetical within a depth. A root file is usually the one that applies to
 * the whole repository, so it is the last to be left out by the caps. */
export function matchInstructionPaths(
  tree: string[],
  pattern: RegExp,
): string[] {
  return tree
    .filter((path) => pattern.test(path))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

export type InstructionSelection = {
  files: Record<string, string>;
  /** Each path that was not read, with the reason. */
  leftOut: { path: string; reason: string }[];
};

/** Applies the total size cap to files already read in reading order. A file
 * that would cross the cap is left out and later, smaller ones still fit. */
export function capInstructionFiles(
  ordered: { path: string; content: string | undefined }[],
  maxChars = MAX_INSTRUCTION_CHARS,
): InstructionSelection {
  const files: Record<string, string> = {};
  const leftOut: { path: string; reason: string }[] = [];
  let total = 0;
  for (const { path, content } of ordered) {
    if (content === undefined) {
      leftOut.push({ path, reason: "could not be read" });
      continue;
    }
    if (total + content.length > maxChars) {
      leftOut.push({
        path,
        reason: `over the ${maxChars.toLocaleString("en-US")}-character cap`,
      });
      continue;
    }
    files[path] = content;
    total += content.length;
  }
  return { files, leftOut };
}

/** One log line naming every file a build did not read. */
export function leftOutLine(
  leftOut: { path: string; reason: string }[],
): string {
  // A pattern that matches the whole tree would otherwise print every path.
  const shown = leftOut.slice(0, 20);
  const more = leftOut.length - shown.length;
  return `instruction files left out: ${shown
    .map(({ path, reason }) => `${path} (${reason})`)
    .join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}
