import {
  canPrompt,
  ensureCodegraphForReview,
  type Presence,
} from "../tools/codegraph.ts";
import type { ToolHandler } from "../ai/mermaid_loop.ts";
import { codegraphTools, ensureCodegraphIndex } from "../pr/codegraph_tools.ts";
import {
  createCodegraphRunner,
  LOCAL_CODEGRAPH_DIR,
} from "../tools/codegraph_exec.ts";
import { log, startHeartbeat } from "../util/log.ts";
import { ensureCodegraphGitExclude } from "./codegraph_exclude.ts";
import { pathExists, type Run, runCommand } from "../pr/checkout.ts";

export type LocalCodegraphState = "used" | "disabled" | "unavailable";

export type LocalCodegraphPrepare = {
  state: LocalCodegraphState;
  reason: string | null;
  tools: ToolHandler[];
};

export async function prepareLocalCodegraph(input: {
  gitRoot: string;
  enabled: boolean;
  allowInstall: boolean;
  /** Overrides the TTY/CI detection, for tests. */
  interactive?: boolean;
  run?: Run;
  detect?: () => Promise<Presence>;
}): Promise<LocalCodegraphPrepare> {
  if (!input.enabled) {
    return { state: "disabled", reason: null, tools: [] };
  }
  const run = input.run ?? runCommand;
  await ensureCodegraphGitExclude(input.gitRoot, run);
  const resolved = await ensureCodegraphForReview({
    allowInstall: input.allowInstall,
    // The prompt is safe only when a human can answer it; `canPrompt` checks
    // stdin, stdout and `CI`, so a `</dev/null` or piped run never asks (F01).
    interactive: input.interactive ?? canPrompt(),
    log: (message) =>
      log("codegraph", message.replace(/^\[codegraph\]\s*/, "")),
  });
  if (!("path" in resolved)) {
    log("codegraph", `tools unavailable · ${resolved.reason}`);
    return { state: "unavailable", reason: resolved.reason, tools: [] };
  }
  const binary = resolved.path;
  const cgRun = createCodegraphRunner(LOCAL_CODEGRAPH_DIR);
  try {
    const fresh = !(await pathExists(
      `${input.gitRoot}/${LOCAL_CODEGRAPH_DIR}`,
    ));
    if (fresh) {
      log(
        "codegraph",
        "building code index for the first time (this can take a few minutes)",
      );
      const stop = startHeartbeat("codegraph init");
      try {
        await ensureCodegraphIndex(
          binary,
          input.gitRoot,
          cgRun,
          LOCAL_CODEGRAPH_DIR,
        );
      } finally {
        stop();
      }
    } else {
      await ensureCodegraphIndex(
        binary,
        input.gitRoot,
        cgRun,
        LOCAL_CODEGRAPH_DIR,
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const line = reason.split("\n")[0] || "codegraph index failed";
    log("codegraph", `tools unavailable · ${line}`);
    return { state: "unavailable", reason: line, tools: [] };
  }
  return {
    state: "used",
    reason: null,
    tools: codegraphTools(binary, input.gitRoot, cgRun),
  };
}
