import type { ToolHandler } from "../ai/mermaid_loop.ts";
import {
  ensureWorktree,
  pathExists,
  type Run,
  runCommand,
} from "./checkout.ts";
import { detect, type Presence } from "../tools/codegraph.ts";
import {
  createCodegraphRunner,
  LOCAL_CODEGRAPH_DIR,
  runCodegraphTool,
  SERVER_CODEGRAPH_DIR,
  type CodegraphRunner,
} from "../tools/codegraph_exec.ts";
import { log } from "../util/log.ts";
import {
  guardToolArgs,
  rejectEscapingPath,
  rejectFlagLike,
} from "./codegraph_tool_args.ts";

// Each codegraph subcommand as its own tool, no synthesis step in between —
// verified against the installed `codegraph <command> --help` output.

type Args = Record<string, unknown>;

function str(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function num(args: Args, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function strArray(args: Args, key: string): string[] {
  const value = args[key];
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export async function ensureCodegraphIndex(
  binary: string,
  worktree: string,
  runner: CodegraphRunner,
  indexDir = SERVER_CODEGRAPH_DIR,
): Promise<void> {
  const started = performance.now();
  const fresh = !(await pathExists(`${worktree}/${indexDir}`));
  const initCmd = indexDir === LOCAL_CODEGRAPH_DIR
    ? ["init", "-y", "."]
    : ["init", "."];
  let result = await runner(binary, fresh ? initCmd : ["sync", "."], worktree);
  if (!fresh && result.code !== 0 && /lock/i.test(result.stderr + result.stdout)) {
    await runner(binary, ["unlock", "."], worktree);
    result = await runner(binary, ["sync", "."], worktree);
  }
  if (result.code !== 0) {
    result = await runner(binary, ["index", "."], worktree);
  }
  if (result.code !== 0) {
    throw new Error(
      `codegraph ${fresh ? "init" : "sync"} failed: ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  const indexed = result.stdout.match(/Indexed ([\d.]+) files/)?.[1] ??
    result.stdout.match(/Synced (\d+) changed files/)?.[1] ?? "?";
  log(
    "codegraph",
    `${fresh ? "init" : "sync"} · ${indexed} files · ${
      ((performance.now() - started) / 1000).toFixed(1)
    }s`,
  );
}

/** Uses `detect`, never `ensureCodegraph`: the latter can call `Deno.exit` on
 * a declined or failed install, fine for a one-time `init`/`remake`/`serve`
 * setup step but not for a single review that happens to want this tool. */
export async function prepareCodegraphTools(
  repo: string,
  pr: number,
  commit: string,
  options: { run?: Run; detect?: () => Promise<Presence> } = {},
): Promise<ToolHandler[]> {
  const runner = options.run ?? runCommand;
  const detectPresence = options.detect ?? detect;
  try {
    const presence = await detectPresence();
    if (presence.state !== "ok") {
      log("codegraph", `tools unavailable · codegraph is ${presence.state}`);
      return [];
    }
    const worktree = await ensureWorktree(repo, pr, commit, runner);
    const cgRun = createCodegraphRunner(SERVER_CODEGRAPH_DIR);
    await ensureCodegraphIndex(presence.path, worktree, cgRun);
    return codegraphTools(presence.path, worktree, cgRun);
  } catch (error) {
    log("codegraph", `tools unavailable · ${String(error)}`);
    return [];
  }
}

/** Tool schemas for the remote bridge (runs are proxied to the CLI). */
export function codegraphToolHandlersForBridge(): ToolHandler[] {
  return codegraphTools(
    "codegraph",
    ".",
    createCodegraphRunner(SERVER_CODEGRAPH_DIR),
  );
}

export function codegraphTools(
  binary: string,
  worktree: string,
  runner: CodegraphRunner = createCodegraphRunner(SERVER_CODEGRAPH_DIR),
): ToolHandler[] {
  const run = (args: string[]) =>
    runCodegraphTool(binary, args, worktree, runner);
  return [
    {
      name: "codegraph-query",
      tool: {
        type: "function",
        function: {
          name: "codegraph-query",
          description:
            "Search for symbols (functions, classes, types, etc.) by name across the indexed repository.",
          parameters: {
            type: "object",
            properties: {
              search: {
                type: "string",
                description: "The symbol name or search term.",
              },
              kind: {
                type: "string",
                description: "Restrict to a node kind, e.g. function, class.",
              },
              limit: {
                type: "number",
                description: "Maximum results (default 10).",
              },
            },
            required: ["search"],
            additionalProperties: false,
          },
        },
      },
      run: (args) => {
        const a = args as Args;
        const keys = new Set(["search", "kind", "limit"]);
        const guard = guardToolArgs(a, keys);
        if (guard) return Promise.resolve(guard);
        const search = str(a, "search");
        if (!search) {
          return Promise.resolve("codegraph-query requires 'search'.");
        }
        const flag = rejectFlagLike(search, "search");
        if (flag) return Promise.resolve(flag);
        const kind = str(a, "kind");
        if (kind) {
          const kindFlag = rejectFlagLike(kind, "kind");
          if (kindFlag) return Promise.resolve(kindFlag);
        }
        const limit = num(a, "limit");
        return run([
          "query",
          search,
          ...(kind ? ["-k", kind] : []),
          ...(limit ? ["-l", String(limit)] : []),
        ]);
      },
    },
    {
      name: "codegraph-node",
      tool: {
        type: "function",
        function: {
          name: "codegraph-node",
          description:
            "One symbol's source plus its caller/callee trail, given its name. Or, with `file` set instead, that file's own symbol map and dependents.",
          parameters: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "A symbol name to look up.",
              },
              file: {
                type: "string",
                description:
                  "A file path — reads the file's symbol map instead of a single symbol.",
              },
              symbolsOnly: {
                type: "boolean",
                description:
                  "With `file`: return only the symbol map, not source text.",
              },
            },
            additionalProperties: false,
          },
        },
      },
      run: (args) => {
        const a = args as Args;
        const keys = new Set(["name", "file", "symbolsOnly"]);
        const guard = guardToolArgs(a, keys);
        if (guard) return Promise.resolve(guard);
        const name = str(a, "name");
        const file = str(a, "file");
        if (!name && !file) {
          return Promise.resolve("codegraph-node requires 'name' or 'file'.");
        }
        if (name) {
          const flag = rejectFlagLike(name, "name");
          if (flag) return Promise.resolve(flag);
        }
        if (file) {
          const pathErr = rejectEscapingPath(file);
          if (pathErr) return Promise.resolve(pathErr);
        }
        return run([
          "node",
          ...(name ? [name] : []),
          ...(file ? ["-f", file] : []),
          ...(a.symbolsOnly ? ["--symbols-only"] : []),
        ]);
      },
    },
    {
      name: "codegraph-explore",
      tool: {
        type: "function",
        function: {
          name: "codegraph-explore",
          description:
            "Explore an area of the codebase by a natural-language query: relevant symbols' source and call paths in one shot.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "What to explore, in plain words.",
              },
              maxFiles: {
                type: "number",
                description: "Maximum number of files to include source from.",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      },
      run: (args) => {
        const a = args as Args;
        const keys = new Set(["query", "maxFiles"]);
        const guard = guardToolArgs(a, keys);
        if (guard) return Promise.resolve(guard);
        const query = str(a, "query");
        if (!query) {
          return Promise.resolve("codegraph-explore requires 'query'.");
        }
        const flag = rejectFlagLike(query, "query");
        if (flag) return Promise.resolve(flag);
        const parts = query.split(/\s+/).filter(Boolean);
        for (const part of parts) {
          const partFlag = rejectFlagLike(part, "query");
          if (partFlag) return Promise.resolve(partFlag);
        }
        const maxFiles = num(a, "maxFiles");
        return run([
          "explore",
          ...parts,
          ...(maxFiles ? ["--max-files", String(maxFiles)] : []),
        ]);
      },
    },
    {
      name: "codegraph-callers",
      tool: {
        type: "function",
        function: {
          name: "codegraph-callers",
          description:
            "Find every function or method that calls a specific symbol.",
          parameters: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              limit: {
                type: "number",
                description: "Maximum results (default 20).",
              },
            },
            required: ["symbol"],
            additionalProperties: false,
          },
        },
      },
      run: (args) => {
        const a = args as Args;
        const keys = new Set(["symbol", "limit"]);
        const guard = guardToolArgs(a, keys);
        if (guard) return Promise.resolve(guard);
        const symbol = str(a, "symbol");
        if (!symbol) {
          return Promise.resolve("codegraph-callers requires 'symbol'.");
        }
        const flag = rejectFlagLike(symbol, "symbol");
        if (flag) return Promise.resolve(flag);
        const limit = num(a, "limit");
        return run([
          "callers",
          symbol,
          ...(limit ? ["-l", String(limit)] : []),
        ]);
      },
    },
    {
      name: "codegraph-callees",
      tool: {
        type: "function",
        function: {
          name: "codegraph-callees",
          description:
            "Find every function or method that a specific symbol calls.",
          parameters: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              limit: {
                type: "number",
                description: "Maximum results (default 20).",
              },
            },
            required: ["symbol"],
            additionalProperties: false,
          },
        },
      },
      run: (args) => {
        const a = args as Args;
        const keys = new Set(["symbol", "limit"]);
        const guard = guardToolArgs(a, keys);
        if (guard) return Promise.resolve(guard);
        const symbol = str(a, "symbol");
        if (!symbol) {
          return Promise.resolve("codegraph-callees requires 'symbol'.");
        }
        const flag = rejectFlagLike(symbol, "symbol");
        if (flag) return Promise.resolve(flag);
        const limit = num(a, "limit");
        return run([
          "callees",
          symbol,
          ...(limit ? ["-l", String(limit)] : []),
        ]);
      },
    },
    {
      name: "codegraph-impact",
      tool: {
        type: "function",
        function: {
          name: "codegraph-impact",
          description:
            "Analyze what else in the codebase is affected by changing a specific symbol — its blast radius.",
          parameters: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              depth: {
                type: "number",
                description: "Traversal depth (default 2).",
              },
            },
            required: ["symbol"],
            additionalProperties: false,
          },
        },
      },
      run: (args) => {
        const a = args as Args;
        const keys = new Set(["symbol", "depth"]);
        const guard = guardToolArgs(a, keys);
        if (guard) return Promise.resolve(guard);
        const symbol = str(a, "symbol");
        if (!symbol) {
          return Promise.resolve("codegraph-impact requires 'symbol'.");
        }
        const flag = rejectFlagLike(symbol, "symbol");
        if (flag) return Promise.resolve(flag);
        const depth = num(a, "depth");
        return run([
          "impact",
          symbol,
          ...(depth ? ["-d", String(depth)] : []),
        ]);
      },
    },
    {
      name: "codegraph-affected",
      tool: {
        type: "function",
        function: {
          name: "codegraph-affected",
          description:
            "Find test files affected by one or more changed source files — the direct way to check whether a change is covered by any test, instead of guessing from the diff.",
          parameters: {
            type: "object",
            properties: {
              files: {
                type: "array",
                items: { type: "string" },
                description:
                  "Changed file paths, exactly as shown in this pull request.",
              },
              depth: {
                type: "number",
                description: "Max dependency traversal depth (default 5).",
              },
            },
            required: ["files"],
            additionalProperties: false,
          },
        },
      },
      run: (args) => {
        const a = args as Args;
        const keys = new Set(["files", "depth"]);
        const guard = guardToolArgs(a, keys);
        if (guard) return Promise.resolve(guard);
        const files = strArray(a, "files");
        if (files.length === 0) {
          return Promise.resolve(
            "codegraph-affected requires a non-empty 'files' array.",
          );
        }
        for (const file of files) {
          const pathErr = rejectEscapingPath(file);
          if (pathErr) return Promise.resolve(pathErr);
        }
        const depth = num(a, "depth");
        return run([
          "affected",
          ...files,
          ...(depth ? ["-d", String(depth)] : []),
        ]);
      },
    },
  ];
}
