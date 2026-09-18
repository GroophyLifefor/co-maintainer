/** Test-only cross-runtime primitives, backed by `node:*` so the same test
 * file runs under both `deno test` and `node --test` during the migration.
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
};

export type CommandOutput = {
  success: boolean;
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

/** Minimal stand-in for `Deno.Command(...).output()` used by tests. */
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
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({
          success: code === 0,
          code: code ?? 1,
          stdout: new Uint8Array(Buffer.concat(stdout)),
          stderr: new Uint8Array(Buffer.concat(stderr)),
        });
      });
    });
  }
}

const isDeno = typeof (globalThis as { Deno?: unknown }).Deno !== "undefined";

/** Path to the running runtime binary (deno or node). */
export function runtimeExecPath(): string {
  return isDeno
    ? (
        globalThis as unknown as { Deno: { execPath(): string } }
      ).Deno.execPath()
    : process.execPath;
}

/** Arguments that run a `.ts` entrypoint on the current runtime. */
export function runtimeRunArgs(script: string, args: string[]): string[] {
  return isDeno ? ["run", "--allow-all", script, ...args] : [script, ...args];
}
