import type { CommandResult } from "./codegraph.ts";
import {
  commandOutput,
  commandSpawn,
  envToObject,
  isWindows,
  type CommandOutput,
} from "../util/runtime.ts";

export const LOCAL_CODEGRAPH_DIR = ".co-maintainer-codegraph";
export const SERVER_CODEGRAPH_DIR = ".codegraph";
const TOOL_TIMEOUT_MS = 60_000;
const INDEX_COMMANDS = new Set(["init", "sync", "index", "unlock"]);

export type ExecOptions = {
  timeoutMs?: number | null;
  codegraphDir?: string;
  env?: Record<string, string>;
};

export type CodegraphRunner = (
  binary: string,
  args: string[],
  worktree: string,
) => Promise<CommandResult>;

/** Run the codegraph CLI in a repo root (plan §13.4).
 *
 * On Windows the CLI is a `.cmd`/`.ps1` shim, and `node:child_process.spawn`
 * cannot execute those without a shell — it fails with `EINVAL`. `Deno.Command`
 * resolved them natively, so this wrapper is needed only after the Node move.
 * Route through `cmd /c` exactly like `pr/checkout.ts` does for `git`.
 */
export async function execCodegraph(
  binary: string,
  args: string[],
  cwd: string,
  options: ExecOptions = {},
): Promise<CommandResult> {
  const indexDir = options.codegraphDir ?? LOCAL_CODEGRAPH_DIR;
  const env = {
    ...envToObject(),
    CODEGRAPH_DIR: indexDir,
    ...options.env,
  };
  const timeoutMs =
    options.timeoutMs === undefined ? TOOL_TIMEOUT_MS : options.timeoutMs;
  const windows = isWindows();
  const commandOptions = {
    args: windows ? ["/c", binary, ...args] : args,
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  } as const;
  const target = windows ? "cmd" : binary;
  if (timeoutMs === null) {
    const output = await commandOutput(target, commandOptions);
    return decode(output);
  }
  const proc = commandSpawn(target, commandOptions);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const output = await proc.output();
  clearTimeout(timer);
  if (timedOut) {
    return {
      code: 1,
      stdout: "",
      stderr: `codegraph ${args[0] ?? ""} timed out after ${timeoutMs / 1000}s`,
    };
  }
  return decode(output);
}

function decode(output: CommandOutput): CommandResult {
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

export function createCodegraphRunner(indexDir: string): CodegraphRunner {
  return (binary, args, worktree) => {
    const timeoutMs = INDEX_COMMANDS.has(args[0] ?? "") ? null : undefined;
    return execCodegraph(binary, args, worktree, {
      timeoutMs,
      codegraphDir: indexDir,
    });
  };
}

export async function runCodegraphTool(
  binary: string,
  args: string[],
  worktree: string,
  runner: CodegraphRunner,
): Promise<string> {
  const result = await runner(binary, args, worktree);
  const output = result.stdout.trim() || result.stderr.trim();
  if (result.code !== 0) {
    return `codegraph ${args[0]} exited ${result.code}: ${output}`;
  }
  return output || "(no output)";
}
