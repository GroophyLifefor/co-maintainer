/** `search-non-code`: a review tool for the files codegraph does not index
 * (issue 79). Codegraph follows code, and a review missed a paragraph a change
 * made false or a compose entry outside the changed hunk because nothing could
 * read docs or configuration.
 *
 * It is not a general grep. It searches tracked files only, through
 * `git grep`, so an untracked `.env` is never read. Binary files are skipped,
 * and so is every file codegraph parses (`CODEGRAPH_EXTENSIONS`) and every
 * file the repository's `agentInstructions` pattern matches, because
 * `INSTRUCTIONS.md` already carries their rules. */
import type { ToolHandler } from "../ai/mermaid_loop.ts";
import type { Json } from "../types.ts";
import { readConfig } from "../config.ts";
import { agentInstructionsPattern } from "../knowledge/instruction_files.ts";
import { commandSpawn } from "../util/runtime.ts";
import { CODEGRAPH_EXTENSIONS } from "./codegraph.ts";
import {
  guardToolArgs,
  rejectEscapingPath,
  toolError,
} from "../pr/codegraph_tool_args.ts";

export const SEARCH_NON_CODE = "search-non-code";

/** Most matches one answer lists. */
export const SEARCH_MAX_MATCHES = 30;
/** Most characters of one listed line. */
export const SEARCH_LINE_MAX_CHARS = 200;
/** Time limit of a regex search. */
export const SEARCH_REGEX_TIMEOUT_MS = 5000;
/** A literal search is fast, so its limit only stops a stuck one. */
export const SEARCH_LITERAL_TIMEOUT_MS = 15_000;
/** Output kept from one git grep run. 30 matches need far less, the rest
 * only feeds the per-file counts, so they say "at least" past this. */
export const SEARCH_MAX_OUTPUT_BYTES = 1_000_000;
/** Default for `reviewSearchMaxContextLines`. */
export const DEFAULT_SEARCH_MAX_CONTEXT_LINES = 3;
/** Most files the `and N more matches` line names. */
const MAX_MORE_FILES = 30;

/** The repository's most context lines around a match, or `null` for no
 * limit. Unset takes the default, 0 or a negative number means no limit. */
export function searchMaxContextLines(
  repoConfig: { reviewSearchMaxContextLines?: number } | undefined,
): number | null {
  const raw = repoConfig?.reviewSearchMaxContextLines;
  if (raw === undefined) return DEFAULT_SEARCH_MAX_CONTEXT_LINES;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

export const SEARCH_NON_CODE_TOOL: Json = {
  type: "function",
  function: {
    name: SEARCH_NON_CODE,
    description:
      "Search the repository's tracked files that codegraph does not index: docs, configuration, YAML, JSON, TOML, ini and env templates, Dockerfiles, SQL, shell scripts, HTML and CSS. Code files are not searched, use codegraph for code. The pattern is literal text unless regex is true. Answers at most 30 matches with their line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The text to find. Literal unless regex is true.",
        },
        regex: {
          type: "boolean",
          description: "Treat pattern as a POSIX extended regular expression.",
        },
        path: {
          type: "string",
          description: "Limit the search to this folder or file.",
        },
        context: {
          type: "number",
          description: "Lines to show around each match.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
};

export type GrepResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The output passed `SEARCH_MAX_OUTPUT_BYTES` and the search was
   * stopped there. */
  cut?: boolean;
};

/** Runs `git` with `args` in `cwd`, killed after `timeoutMs` when set. */
export type GrepRun = (
  args: string[],
  cwd: string,
  timeoutMs: number | null,
) => Promise<GrepResult>;

export const runGit: GrepRun = async (args, cwd, timeoutMs) => {
  // Spawned directly, never through a shell: the pattern is the model's text.
  const proc = commandSpawn("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  let timedOut = false;
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          proc.kill("SIGKILL");
        }, timeoutMs);
  const output = await proc.output(SEARCH_MAX_OUTPUT_BYTES);
  if (timer) clearTimeout(timer);
  const decoder = new TextDecoder();
  let stdout = decoder.decode(output.stdout);
  // A stopped run can end mid-record: keep only whole records.
  if (output.cut) stdout = stdout.slice(0, stdout.lastIndexOf("\n") + 1);
  return {
    code: output.code,
    stdout,
    stderr: decoder.decode(output.stderr),
    timedOut,
    ...(output.cut ? { cut: true } : {}),
  };
};

export type SearchOptions = {
  /** Most context lines, `null` for no limit. */
  maxContextLines: number | null;
  /** Files this pattern matches are skipped. */
  instructions: RegExp | null;
  run?: GrepRun;
  timeoutMs?: number;
};

type Line = { path: string; line: number; text: string };

/** `path\0line\0text` records, the `-z` output of `git grep -n`. */
function parseRecords(stdout: string): Line[] {
  const rows: Line[] = [];
  for (const record of stdout.split("\n")) {
    const first = record.indexOf("\0");
    if (first < 0) continue;
    const second = record.indexOf("\0", first + 1);
    if (second < 0) continue;
    const line = Number(record.slice(first + 1, second));
    if (!Number.isInteger(line)) continue;
    rows.push({
      path: record.slice(0, first),
      line,
      text: record.slice(second + 1).replace(/\r$/, ""),
    });
  }
  return rows;
}

function cutLine(text: string): string {
  return text.length > SEARCH_LINE_MAX_CHARS
    ? `${text.slice(0, SEARCH_LINE_MAX_CHARS)}...`
    : text;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `git grep` arguments for one search. Every file codegraph parses is left
 * out by a pathspec, so git never reads it. */
export function grepArgs(input: {
  pattern: string;
  regex: boolean;
  path?: string;
  context: number;
}): string[] {
  return [
    "grep",
    "-n",
    "-I",
    "-z",
    "--no-color",
    "--no-column",
    input.regex ? "-E" : "--fixed-strings",
    ...(input.context > 0 ? [`-C${input.context}`] : []),
    "-e",
    input.pattern,
    "--",
    input.path ? `:(literal)${input.path}` : ".",
    ...CODEGRAPH_EXTENSIONS.map((ext) => `:(exclude,icase,glob)**/*${ext}`),
  ];
}

/** One search, as the model reads it. */
export async function searchNonCode(
  root: string,
  args: unknown,
  options: SearchOptions,
): Promise<string> {
  const a = (args ?? {}) as Record<string, unknown>;
  const guard = guardToolArgs(
    a,
    new Set(["pattern", "regex", "path", "context"]),
  );
  if (guard) return guard;
  const pattern = typeof a.pattern === "string" ? a.pattern : "";
  if (pattern === "") return toolError(`${SEARCH_NON_CODE} requires 'pattern'`);
  if (/[\r\n]/.test(pattern)) {
    return toolError("pattern must be a single line");
  }
  const regex = a.regex === true;
  const path =
    typeof a.path === "string" && a.path.trim() !== "" ? a.path.trim() : "";
  if (path) {
    const escaping = rejectEscapingPath(path);
    if (escaping) return escaping;
  }
  const asked =
    typeof a.context === "number" && Number.isFinite(a.context)
      ? Math.max(0, Math.floor(a.context))
      : 0;
  const context =
    options.maxContextLines === null
      ? asked
      : Math.min(asked, options.maxContextLines);
  const run = options.run ?? runGit;
  // A literal search has a time limit too, only a longer one.
  const timeoutMs =
    options.timeoutMs ??
    (regex ? SEARCH_REGEX_TIMEOUT_MS : SEARCH_LITERAL_TIMEOUT_MS);
  // The match list comes without context, so a context line is never
  // mistaken for a match. `-z` marks both kinds the same way.
  const [matched, around] = await Promise.all([
    run(grepArgs({ pattern, regex, path, context: 0 }), root, timeoutMs),
    context > 0
      ? run(grepArgs({ pattern, regex, path, context }), root, timeoutMs)
      : Promise.resolve(undefined),
  ]);
  if (matched.timedOut || around?.timedOut) {
    return `Search timed out after ${(timeoutMs ?? 0) / 1000} seconds. Use a simpler pattern or a narrower path.`;
  }
  if (matched.code === 1) return noMatches(path);
  if (matched.code !== 0) {
    const why = matched.stderr.trim().split("\n")[0] ?? "";
    return toolError(`search failed${why ? `: ${why}` : ""}`);
  }
  const skip = (row: Line) => options.instructions?.test(row.path) === true;
  const matches = parseRecords(matched.stdout).filter((row) => !skip(row));
  if (matches.length === 0) return noMatches(path);
  const lines = new Map<string, Map<number, string>>();
  for (const row of around ? parseRecords(around.stdout) : []) {
    if (skip(row)) continue;
    let file = lines.get(row.path);
    if (!file) lines.set(row.path, (file = new Map()));
    file.set(row.line, row.text);
  }
  const shown = matches.slice(0, SEARCH_MAX_MATCHES);
  const isMatch = new Set(shown.map((row) => `${row.path}\0${row.line}`));
  const out: string[] = [];
  let last: { path: string; line: number } | undefined;
  for (const row of shown) {
    const from = Math.max(1, row.line - context);
    for (let line = from; line <= row.line + context; line++) {
      if (last && last.path === row.path && line <= last.line) continue;
      const text =
        line === row.line ? row.text : lines.get(row.path)?.get(line);
      if (text === undefined) continue;
      if (
        context > 0 &&
        last &&
        (last.path !== row.path || line > last.line + 1)
      ) {
        out.push("--");
      }
      const match = isMatch.has(`${row.path}\0${line}`);
      out.push(
        `${row.path}${match ? ":" : "-"}${line}${match ? ":" : "-"} ${cutLine(text)}`,
      );
      last = { path: row.path, line };
    }
  }
  const files = new Set(matches.map((row) => row.path));
  const rest = matches.slice(SEARCH_MAX_MATCHES);
  if (rest.length > 0) {
    const perFile = new Map<string, number>();
    for (const row of rest) {
      perFile.set(row.path, (perFile.get(row.path) ?? 0) + 1);
    }
    const named = [...perFile]
      .slice(0, MAX_MORE_FILES)
      .map(([file, count]) => `${file} (${count})`);
    const unnamed = perFile.size - named.length;
    out.push(
      `and ${matched.cut ? "at least " : ""}${plural(rest.length, "more match", "more matches")}: ${named.join(", ")}${
        unnamed > 0 ? `, and ${plural(unnamed, "more file", "more files")}` : ""
      }`,
    );
  }
  out.push(
    `${matched.cut ? "at least " : ""}${plural(matches.length, "match", "matches")} in ${plural(files.size, "file", "files")}`,
  );
  return out.join("\n");
}

function noMatches(path: string): string {
  return `No matches in the tracked files codegraph does not index${
    path ? ` under ${path}` : ""
  }.`;
}

/** The search settings of one repository, from config.json. */
export function searchOptionsFor(repo: string): SearchOptions {
  const repoConfig = readConfig().repos?.[repo];
  let instructions: RegExp | null = null;
  try {
    instructions = agentInstructionsPattern(repoConfig?.agentInstructions);
  } catch {
    // A saved pattern that no longer compiles skips no file here. `sync`
    // names the problem.
    instructions = null;
  }
  return {
    maxContextLines: searchMaxContextLines(repoConfig),
    instructions,
  };
}

/** The tool, searching the tracked files of the tree at `root`. */
export function searchNonCodeTool(
  root: string,
  options: SearchOptions,
): ToolHandler {
  return {
    name: SEARCH_NON_CODE,
    tool: SEARCH_NON_CODE_TOOL,
    run: (args) => searchNonCode(root, args, options),
  };
}
