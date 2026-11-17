/** The tools a review offers the model, prepared in one place for every mode
 * (issue 79): codegraph when it is on, `search-non-code` where a checkout is
 * there to search, and `read-full-diff` from the diff plan. A later kind of
 * tool, such as a repository's MCP servers, joins the list here. */
import type { ToolHandler } from "../ai/mermaid_loop.ts";
import type { Options } from "../types.ts";
import { log } from "../util/log.ts";
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
    }
  /** A tree already on disk with its codegraph tools ready: local review at
   * the git root. */
  | { kind: "tree"; root: string; codegraph: ToolHandler[] }
  /** Tools another process runs: a remote review, where the client runs
   * codegraph and search in its own checkout. */
  | { kind: "bridge"; tools: ToolHandler[] };

export type ReviewTools = {
  /** Every tool to offer, codegraph first. */
  tools: ToolHandler[];
  /** The codegraph tools alone, which decide `codegraphState`. */
  codegraph: ToolHandler[];
};

export type ReviewToolsDeps = {
  run?: Run;
  /** Overrides the codegraph setup, for tests. */
  codegraph?: (worktree: () => Promise<string>) => Promise<ToolHandler[]>;
  /** Overrides the repository's search settings, for tests. */
  search?: SearchOptions;
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
  const [own, diff] = await Promise.all([
    prepareOwnTools(source, options, deps),
    diffTools,
  ]);
  return { ...own, tools: [...own.tools, ...diff] };
}

async function prepareOwnTools(
  source: ReviewToolSource,
  options: Pick<Options, "repo" | "useCodegraph">,
  deps: ReviewToolsDeps,
): Promise<ReviewTools> {
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

/** `codegraphState` from the codegraph tools alone, never from the length of
 * the whole tool list. */
export function codegraphState(
  useCodegraph: boolean | undefined,
  codegraph: ToolHandler[],
): "used" | "disabled" | "unavailable" {
  if (!useCodegraph) return "disabled";
  return codegraph.length > 0 ? "used" : "unavailable";
}
