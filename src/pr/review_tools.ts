/** The tools a review offers the model, prepared in one place for every mode
 * (issue 79): codegraph when it is on, `search-non-code` where a checkout is
 * there to search, `read-full-diff` from the diff plan, and the tools of the
 * repository's MCP servers where the mode runs them. */
import type { ToolHandler } from "../ai/mermaid_loop.ts";
import type { Json, Options } from "../types.ts";
import { log } from "../util/log.ts";
import { readConfig } from "../config.ts";
import { mcpDisabled, type McpServerConfig } from "../tools/mcp_config.ts";
import {
  emptyMcpSession,
  joinMcpSessions,
  type McpSession,
  startMcpSession,
} from "../tools/mcp_tools.ts";
import { ensureWorktree, type Run, runCommand } from "./checkout.ts";
import { prepareCodegraphTools } from "./codegraph_tools.ts";
import {
  searchNonCodeTool,
  searchOptionsFor,
  type SearchOptions,
} from "../tools/search_non_code.ts";

/** Where a review's tools run. */
export type ReviewToolSource =
  /** A checkout co-maintainer makes of the repository: the pull request's
   * worktree for CLI PR and App reviews, worktree 0 at the pushed commit for
   * a push review, which gets no search. */
  | {
      kind: "checkout";
      pr: number;
      commit: string;
      search: boolean;
      allowInstall?: boolean;
      /** Start the repository's MCP servers. */
      mcp?: boolean;
    }
  /** A tree already on disk with its codegraph tools ready: local review at
   * the git root. */
  | { kind: "tree"; root: string; codegraph: ToolHandler[]; mcp?: boolean }
  /** Tools another process runs: a remote review, where the client runs
   * codegraph and search in its own checkout. The server runs the MCP
   * servers it has for the repository itself. `clientTools` holds the tools
   * the client declared, private like MCP results. */
  | {
      kind: "bridge";
      tools: ToolHandler[];
      mcp?: boolean;
      clientTools?: McpSession;
    };

export type ReviewTools = {
  /** Every tool to offer, codegraph first. */
  tools: ToolHandler[];
  /** The codegraph tools alone, which decide `codegraphState`. */
  codegraph: ToolHandler[];
  /** The review's MCP servers, empty when it runs none. The review stops
   * them however it ends. */
  mcp: McpSession;
};

export type ReviewToolsDeps = {
  run?: Run;
  /** Overrides the codegraph setup, for tests. */
  codegraph?: (worktree: () => Promise<string>) => Promise<ToolHandler[]>;
  /** Overrides the repository's search settings, for tests. */
  search?: SearchOptions;
  /** Overrides the MCP start, for tests. */
  mcp?: (servers: Record<string, McpServerConfig>) => Promise<McpSession>;
};

export function isCodegraphTool(name: string): boolean {
  return name.startsWith("codegraph-");
}

/** The review's tools. `diffTools` is the diff plan's own tools
 * (`read-full-diff`), awaited last so the plan and the checkout can be
 * prepared at the same time. A setup that fails leaves its tools out and the
 * review goes on with the rest. */
export async function prepareReviewTools(
  source: ReviewToolSource,
  options: Pick<Options, "repo" | "useCodegraph">,
  diffTools: ToolHandler[] | Promise<ToolHandler[]>,
  deps: ReviewToolsDeps = {},
): Promise<ReviewTools> {
  const starting = startMcp(source, options.repo, deps);
  try {
    const [own, diff, servers] = await Promise.all([
      prepareOwnTools(source, options, deps),
      diffTools,
      starting,
    ]);
    // A remote client's declared tools join the MCP tools: private results,
    // checked for copied passages the same way.
    const mcp =
      source.kind === "bridge" && source.clientTools
        ? joinMcpSessions(servers, source.clientTools)
        : servers;
    return { ...own, tools: [...own.tools, ...diff, ...mcp.tools], mcp };
  } catch (error) {
    // Servers that started while another part failed are stopped here, as
    // the review that would stop them never gets them.
    void starting.then(
      (mcp) => mcp.stop(),
      () => {},
    );
    throw error;
  }
}

/** The repository's MCP servers, started when this mode runs them, none is
 * turned off by `CM_MCP_DISABLED=1`, and the repository has some. */
export async function startMcp(
  source: ReviewToolSource,
  repo: string,
  deps: Pick<ReviewToolsDeps, "mcp"> = {},
): Promise<McpSession> {
  if (!source.mcp || mcpDisabled()) return emptyMcpSession();
  const servers = readConfig().repos?.[repo]?.mcpServers;
  if (!servers || Object.keys(servers).length === 0) {
    return emptyMcpSession();
  }
  return (deps.mcp ?? startMcpSession)(servers);
}

async function prepareOwnTools(
  source: ReviewToolSource,
  options: Pick<Options, "repo" | "useCodegraph">,
  deps: ReviewToolsDeps,
): Promise<Omit<ReviewTools, "mcp">> {
  const search = (root: string) =>
    searchNonCodeTool(root, deps.search ?? searchOptionsFor(options.repo));
  if (source.kind === "bridge") {
    const codegraph = options.useCodegraph
      ? source.tools.filter((tool) => isCodegraphTool(tool.name))
      : [];
    const others = source.tools.filter((tool) => !isCodegraphTool(tool.name));
    return { tools: [...codegraph, ...others], codegraph };
  }
  if (source.kind === "tree") {
    const codegraph = options.useCodegraph ? source.codegraph : [];
    return {
      tools: [...codegraph, search(source.root)],
      codegraph,
    };
  }
  if (!options.useCodegraph && !source.search) {
    return { tools: [], codegraph: [] };
  }
  // One checkout for both, made once, and only when something needs it.
  const run = deps.run ?? runCommand;
  let checkout: Promise<string> | undefined;
  const worktree = () =>
    (checkout ??= ensureWorktree(options.repo, source.pr, source.commit, run));
  let root: string | undefined;
  if (source.search) {
    try {
      root = await worktree();
    } catch (error) {
      log("checkout", `search unavailable · ${String(error)}`);
    }
  }
  const codegraph = options.useCodegraph
    ? await (deps.codegraph
        ? deps.codegraph(worktree)
        : prepareCodegraphTools(worktree, {
            allowInstall: source.allowInstall,
          }))
    : [];
  return {
    tools: [...codegraph, ...(root ? [search(root)] : [])],
    codegraph,
  };
}

/** True when the pull request's head lives in another repository, or in
 * none because the fork was deleted. The same rule as the review policy's
 * `fork`. */
export function pullFromFork(pr: Json, repo: string): boolean {
  const head = pr.head as Json | undefined;
  const headRepo = (head?.repo as Json | undefined)?.full_name;
  return (
    typeof headRepo !== "string" ||
    headRepo.toLowerCase() !== repo.toLowerCase()
  );
}

/** Whether a `serve` review of this pull request may start the repository's
 * MCP servers: a pull request from a fork only with `--mcp-allow-forks=true`. */
export function mcpAllowedForPull(pr: Json, repo: string): boolean {
  if (!pullFromFork(pr, repo)) return true;
  return readConfig().repos?.[repo]?.mcpAllowForks === true;
}

/** `codegraphState` from the codegraph tools alone, never from the length of
 * the whole tool list. */
export function codegraphState(
  useCodegraph: boolean | undefined,
  codegraph: ToolHandler[],
): "used" | "disabled" | "unavailable" {
  if (!useCodegraph) return "disabled";
  return codegraph.length > 0 ? "used" : "unavailable";
}
