import type { CommandResult } from "./codegraph.ts";

export const LOCAL_CODEGRAPH_DIR = ".co-maintainer-codegraph";
const TOOL_TIMEOUT_MS = 60_000;

export type ExecOptions = {
  timeoutMs?: number | null;
  env?: Record<string, string>;
};

/** Run the codegraph CLI in a repo root (plan §13.4). No `cmd /c` wrapper. */
export async function execCodegraph(
  binary: string,
  args: string[],
  cwd: string,
  options: ExecOptions = {},
): Promise<CommandResult> {
  const env = {
    ...Deno.env.toObject(),
    CODEGRAPH_DIR: LOCAL_CODEGRAPH_DIR,
    ...options.env,
  };
  const timeoutMs = options.timeoutMs === undefined
    ? TOOL_TIMEOUT_MS
    : options.timeoutMs;
  const child = new Deno.Command(binary, {
    args,
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  });
  if (timeoutMs === null) {
    const output = await child.output();
    return decode(output);
  }
  const proc = child.spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited
    }
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

function decode(output: Deno.CommandOutput): CommandResult {
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}
