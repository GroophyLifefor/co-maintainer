/** Runs one extension command once.
 *
 * The command is the user's own shell line, so it runs through a shell. It
 * starts with an empty environment: co-maintainer's tokens and keys live in
 * its environment and config, and none of them may reach a third-party
 * command. The command sets what it needs itself, `HOME=... node ...`.
 *
 * It runs in its own process group so a timeout or a cancel reaches every
 * process it started, not only the shell: SIGTERM to the group, then SIGKILL
 * once the grace period is over. */
import { spawn, spawnSync } from "node:child_process";
import { getEnv, isWindows } from "../util/runtime.ts";

/** How long a process group gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 30_000;

/** Half of the 128 KB of output kept for a failure's details. */
const DETAIL_HALF_BYTES = 64 * 1024;

/** stdout is read whole as one JSON document. Past this it is not a response
 * anyone meant to send. */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

export const SPLIT_MARKER =
  "\n[... output cut here, the middle is left out ...]\n";

export type ProcessOutcome = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  /** stdout and stderr together, in arrival order, with the exit code.
   * At most 128 KB: the first 64 KB, a marker, the last 64 KB. */
  details: string;
  timedOut: boolean;
  canceled: boolean;
  stdoutTooLarge: boolean;
  spawnError?: string;
};

/** Keeps the first and the last 64 KB of a stream that may be any size. */
class HeadTail {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;

  push(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headBytes < DETAIL_HALF_BYTES) {
      const room = DETAIL_HALF_BYTES - this.headBytes;
      this.head.push(rest.subarray(0, room));
      this.headBytes += Math.min(room, rest.length);
      rest = rest.subarray(room);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tailBytes - (this.tail[0]?.length ?? 0) >= DETAIL_HALF_BYTES) {
      this.tailBytes -= this.tail.shift()!.length;
    }
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    let tail = Buffer.concat(this.tail);
    if (this.total <= DETAIL_HALF_BYTES * 2) {
      return head + tail.toString("utf8");
    }
    tail = tail.subarray(tail.length - DETAIL_HALF_BYTES);
    return head + SPLIT_MARKER + tail.toString("utf8");
  }
}

/** A path as one shell word. Only paths co-maintainer made are substituted,
 * but a config directory can hold a space (`Application Support`). */
export function shellQuote(value: string): string {
  if (isWindows()) return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const TEMPLATE_VARIABLES = [
  "details_path",
  "review_result_path",
  "diff_path",
] as const;

export type TemplateValues = Record<
  (typeof TEMPLATE_VARIABLES)[number],
  string
>;

/** Variables in a command that co-maintainer does not know. */
export function unknownVariables(command: string): string[] {
  const names = [...command.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map(
    (match) => match[1]!,
  );
  return names.filter(
    (name) => !(TEMPLATE_VARIABLES as readonly string[]).includes(name),
  );
}

/** Puts the run folder's paths into the command. Each value is quoted here, so
 * a template writes `{{details_path}}` bare, not inside its own quotes. */
export function substitute(command: string, values: TemplateValues): string {
  return command.replace(
    /\{\{\s*(details_path|review_result_path|diff_path)\s*\}\}/g,
    (_, name: keyof TemplateValues) => shellQuote(values[name]),
  );
}

/** The environment the command starts with. Empty on POSIX. Windows cannot
 * start a process at all without `SystemRoot`, so that one value is kept. */
function commandEnv(): Record<string, string> {
  if (!isWindows()) return {};
  const root = getEnv("SystemRoot");
  return root ? { SystemRoot: root } : {};
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (isWindows()) {
    // Windows has no process groups to signal. taskkill /T walks the tree.
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/** Process groups still running. An extension runs in its own group, so a
 * Ctrl-C in the terminal, which signals the terminal's group, never reaches
 * it. co-maintainer ending for any reason ends them too. */
const liveGroups = new Set<number>();
let exitHooked = false;

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  const killAll = () => {
    for (const pid of liveGroups) killGroup(pid, "SIGTERM");
    liveGroups.clear();
  };
  process.on("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const onSignal = () => {
      killAll();
      // Alone on this signal, the listener must not swallow it: it steps
      // aside and raises it again, so the default exit still happens.
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, onSignal);
        process.kill(process.pid, signal);
      }
    };
    try {
      process.on(signal, onSignal);
    } catch {
      // Not every platform has every signal.
    }
  }
}

/** How long the pipes may stay open once the shell has exited. Whatever the
 * command left behind in its group is killed at that moment. A process that
 * left the group (`setsid`, a daemon) cannot be reached, so its pipes are
 * closed from this side after this window and the run ends with what it read. */
export const DRAIN_MS = 250;

export function shellArgs(
  command: string,
  windows: boolean = isWindows(),
): [string, string[]] {
  return windows
    ? [getEnv("ComSpec") ?? "cmd.exe", ["/d", "/s", "/c", command]]
    : ["/bin/sh", ["-c", command]];
}

export function runCommandOnce(input: {
  command: string;
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  killGraceMs?: number;
  drainMs?: number;
}): Promise<ProcessOutcome> {
  const grace = input.killGraceMs ?? KILL_GRACE_MS;
  const drain = input.drainMs ?? DRAIN_MS;
  return new Promise((resolve) => {
    const details = new HeadTail();
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutTooLarge = false;
    let timedOut = false;
    let canceled = false;
    let settled = false;
    const [shell, args] = shellArgs(input.command);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, args, {
        cwd: input.cwd || undefined,
        env: commandEnv(),
        detached: !isWindows(),
        windowsVerbatimArguments: isWindows(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        details: "",
        timedOut: false,
        canceled: false,
        stdoutTooLarge: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const pid = child.pid;
    if (pid !== undefined) {
      hookExit();
      liveGroups.add(pid);
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (pid === undefined || killTimer) return;
      killGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), grace);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);
    const onAbort = () => {
      canceled = true;
      stop();
    };
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      details.push(chunk);
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stdoutTooLarge = true;
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => details.push(chunk));
    const finish = (
      code: number | null,
      signal: string | null,
      spawnError?: string,
    ) => {
      if (settled) return;
      settled = true;
      if (pid !== undefined) liveGroups.delete(pid);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      input.signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const exit = spawnError
        ? `could not start: ${spawnError}`
        : signal
          ? `exit: killed by ${signal}`
          : `exit code: ${code}`;
      const output = details.text();
      resolve({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        details: output ? `${exit}\n${output}` : exit,
        timedOut,
        canceled,
        stdoutTooLarge,
        ...(spawnError ? { spawnError } : {}),
      });
    };
    child.on("error", (error) => finish(null, null, error.message));
    child.on("close", (code, signal) => finish(code, signal));
    // `close` waits for every holder of the pipes. Once the shell itself has
    // exited, what is left of its group is killed and the pipes get a short
    // window to drain, so a background child cannot hold the run open.
    child.on("exit", (code, signal) => {
      if (pid !== undefined) killGroup(pid, "SIGKILL");
      drainTimer = setTimeout(() => finish(code, signal), drain);
    });
  });
}
