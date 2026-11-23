/** Test-only process and filesystem helpers, backed by `node:*`.
 * Production code never imports this. Filesystem/env helpers are re-exported
 * from the production shim so there is one implementation.
 */
import { spawn } from "node:child_process";

export {
  deleteEnv,
  envToObject,
  getEnv,
  makeTempDir as tempDir,
  makeTempDirSync as tempDirSync,
  mkdir as mkdirPath,
  mkdirSync as mkdirPathSync,
  readDir,
  readFile,
  readTextFile,
  remove as removePath,
  setEnv,
  writeTextFile,
  writeTextFileSync,
} from "../util/runtime.ts";

export type DirEntry = { name: string; isFile: boolean };

export type CommandOptions = {
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: "piped";
  stderr?: "piped";
  stdin?: "piped";
  shell?: boolean;
  /** Kills the child after this many milliseconds and reports code `124`, so a
   * test can prove a command terminates instead of hanging. */
  timeoutMs?: number;
};

export type CommandOutput = {
  success: boolean;
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

/** Runs a command to completion and captures its output, for tests. */
export class Command {
  readonly #command: string;
  readonly #options: CommandOptions;

  constructor(command: string, options: CommandOptions = {}) {
    this.#command = command;
    this.#options = options;
  }

  output(): Promise<CommandOutput> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#command, this.#options.args ?? [], {
        cwd: this.#options.cwd,
        env: this.#options.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: this.#options.shell ?? false,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timer = this.#options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, this.#options.timeoutMs)
        : undefined;
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          // A killed child reports its own signal code, 124 is the `timeout`
          // convention so the caller can tell "hung" from "failed".
          success: !timedOut && code === 0,
          code: timedOut ? 124 : (code ?? 1),
          stdout: new Uint8Array(Buffer.concat(stdout)),
          stderr: new Uint8Array(Buffer.concat(stderr)),
        });
      });
    });
  }
}

/** Path to the running node binary. */
export function runtimeExecPath(): string {
  return process.execPath;
}

/** Arguments that run a `.ts` entrypoint with node. */
export function runtimeRunArgs(script: string, args: string[]): string[] {
  return [script, ...args];
}
