import type { ToolHandler } from "../ai/mermaid_loop.ts";
import { pathExists, type Run, runCommand } from "../pr/checkout.ts";
import {
  codegraphTools,
} from "../pr/codegraph_tools.ts";
import {
  ensureCodegraphForReview,
  type Presence,
} from "../tools/codegraph.ts";
import {
  execCodegraph,
  LOCAL_CODEGRAPH_DIR,
} from "../tools/codegraph_exec.ts";
import { log, startHeartbeat } from "../util/log.ts";
import { ensureCodegraphGitExclude } from "./codegraph_exclude.ts";

export type LocalCodegraphState = "used" | "disabled" | "unavailable";

export type LocalCodegraphPrepare = {
  state: LocalCodegraphState;
  reason: string | null;
  tools: ToolHandler[];
};

function codegraphRunner(binary: string, gitRoot: string): Run {
  return async (_command, args, cwd) => {
    const timeoutMs = args[0] === "init" || args[0] === "sync" ||
        args[0] === "index" || args[0] === "unlock"
      ? null
      : undefined;
    return await execCodegraph(binary, args, cwd ?? gitRoot, { timeoutMs });
  };
}

async function syncIndex(
  binary: string,
  gitRoot: string,
  runner: Run,
): Promise<string | null> {
  const indexDir = `${gitRoot}/${LOCAL_CODEGRAPH_DIR}`;
  const fresh = !(await pathExists(indexDir));
  if (fresh) {
    log(
      "codegraph",
      "building code index for the first time (this can take a few minutes)",
    );
    const stop = startHeartbeat("codegraph init");
    const result = await runner(binary, ["init", "-y", "."], gitRoot);
    stop();
    if (result.code !== 0) {
      const text = result.stderr.trim() || result.stdout.trim();
      if (/home directory/i.test(text)) {
        return "repo root looks like a home directory";
      }
      return text.split("\n")[0] || "codegraph init failed";
    }
    return null;
  }
  let result = await runner(binary, ["sync", "."], gitRoot);
  if (result.code !== 0 && /lock/i.test(result.stderr + result.stdout)) {
    await runner(binary, ["unlock", "."], gitRoot);
    result = await runner(binary, ["sync", "."], gitRoot);
  }
  if (result.code !== 0) {
    result = await runner(binary, ["index", "."], gitRoot);
  }
  if (result.code !== 0) {
    return (result.stderr.trim() || result.stdout.trim()).split("\n")[0] ||
      "codegraph sync failed";
  }
  return null;
}

export async function prepareLocalCodegraph(input: {
  gitRoot: string;
  enabled: boolean;
  allowInstall: boolean;
  interactive: boolean;
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
    interactive: input.interactive,
    log: (message) => log("codegraph", message.replace(/^\[codegraph\]\s*/, "")),
  });
  if (!("path" in resolved)) {
    log("codegraph", `tools unavailable · ${resolved.reason}`);
    return { state: "unavailable", reason: resolved.reason, tools: [] };
  }
  const binary = resolved.path;
  const runner = codegraphRunner(binary, input.gitRoot);
  const indexError = await syncIndex(binary, input.gitRoot, runner);
  if (indexError) {
    log("codegraph", `tools unavailable · ${indexError}`);
    return { state: "unavailable", reason: indexError, tools: [] };
  }
  return {
    state: "used",
    reason: null,
    tools: codegraphTools(binary, input.gitRoot, runner),
  };
}
