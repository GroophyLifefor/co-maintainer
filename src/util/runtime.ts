/** Production runtime helpers for the Node migration.
 *
 * These deliberately mirror the Deno API names and shapes the codebase was
 * written against, so the migration is a mechanical `Deno.foo(` → `foo(`
 * substitution and every deviation lives in exactly one file. Centralizes the
 * two silent-break classes too: `"windows"` vs `"win32"`, and
 * `Deno.errors.NotFound` vs `ENOENT`.
 */
import {
  chmod as fsChmod,
  lstat as fsLstat,
  mkdir as fsMkdir,
  mkdtemp as fsMkdtemp,
  readFile as fsReadFile,
  readdir,
  readlink as fsReadLink,
  rename as fsRename,
  rm as fsRm,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import {
  mkdirSync as fsMkdirSync,
  mkdtempSync as fsMkdtempSync,
  readFileSync as fsReadFileSync,
  rmSync as fsRmSync,
  statSync as fsStatSync,
  writeFileSync as fsWriteFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function isWindows(): boolean {
  return process.platform === "win32";
}

export type Platform = "windows" | "darwin" | "linux";

/** The current OS in the vocabulary the config paths already used under Deno
 * (`"windows"`, not Node's `"win32"`). */
export function currentPlatform(): Platform {
  return isWindows()
    ? "windows"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";
}

/** A missing path: Node's `ENOENT`, plus `ENOTDIR` (a parent is a file). */
export function isNotFound(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// ---------------------------------------------------------------- environment

export function getEnv(name: string): string | undefined {
  return process.env[name];
}

export function setEnv(name: string, value: string): void {
  process.env[name] = value;
}

export function deleteEnv(name: string): void {
  delete process.env[name];
}

export function envToObject(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ------------------------------------------------------------------- sync fs

export function readTextFileSync(path: string | URL): string {
  return fsReadFileSync(path, "utf8");
}

export function writeTextFileSync(path: string | URL, text: string): void {
  fsWriteFileSync(path, text);
}

export function mkdirSync(
  path: string | URL,
  options?: { recursive?: boolean },
): void {
  fsMkdirSync(path, { recursive: options?.recursive ?? false });
}

export function removeSync(
  path: string | URL,
  options?: { recursive?: boolean },
): void {
  fsRmSync(path, { recursive: options?.recursive ?? false, force: false });
}

export function statSync(path: string | URL): Stats {
  return fsStatSync(path);
}

// ------------------------------------------------------------------ async fs

export function readTextFile(path: string | URL): Promise<string> {
  return fsReadFile(path, "utf8");
}

export function readFile(path: string | URL): Promise<Uint8Array> {
  return fsReadFile(path);
}

export function writeTextFile(path: string | URL, text: string): Promise<void> {
  return fsWriteFile(path, text);
}

export function writeFile(
  path: string | URL,
  data: Uint8Array | string,
): Promise<void> {
  return fsWriteFile(path, data);
}

export function mkdir(
  path: string | URL,
  options?: { recursive?: boolean },
): Promise<void> {
  return fsMkdir(path, { recursive: options?.recursive ?? false }).then(
    () => {},
  );
}

export function remove(
  path: string | URL,
  options?: { recursive?: boolean },
): Promise<void> {
  return fsRm(path, { recursive: options?.recursive ?? false, force: false });
}

export function stat(path: string | URL): Promise<Stats> {
  return fsStat(path);
}

export function lstat(path: string | URL): Promise<Stats> {
  return fsLstat(path);
}

export function readLink(path: string | URL): Promise<string> {
  return fsReadLink(path);
}

export function rename(from: string, to: string): Promise<void> {
  return fsRename(from, to);
}

export function chmod(path: string, mode: number): Promise<void> {
  return fsChmod(path, mode);
}

export function makeTempDir(options?: { prefix?: string }): Promise<string> {
  return fsMkdtemp(join(tmpdir(), options?.prefix ?? "cm-"));
}

export function makeTempDirSync(options?: { prefix?: string }): string {
  return fsMkdtempSync(join(tmpdir(), options?.prefix ?? "cm-"));
}

/** A uniquely named temp file (created empty), mirroring `Deno.makeTempFile`.
 *
 * `wx` fails on collision instead of truncating an existing file, so the retry
 * loop preserves `mkdtemp`'s uniqueness without leaving a directory behind —
 * callers only ever delete the returned file. */
export async function makeTempFile(options?: {
  prefix?: string;
  suffix?: string;
}): Promise<string> {
  const prefix = options?.prefix ?? "cm-";
  const suffix = options?.suffix ?? "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const path = join(tmpdir(), `${prefix}${crypto.randomUUID()}${suffix}`);
    try {
      await fsWriteFile(path, "", { flag: "wx" });
      return path;
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`could not create a temp file with prefix ${prefix}`);
}

export type DirEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
};

export async function* readDir(dir: string | URL): AsyncGenerator<DirEntry> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    yield {
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymlink: entry.isSymbolicLink(),
    };
  }
}

// ------------------------------------------------------------------- process

export type CommandOptions = {
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: "piped";
  stdout?: "piped";
  stderr?: "piped";
  /** Windows runs `.cmd`/shell builtins only through a shell. */
  shell?: boolean;
};

export type CommandOutput = {
  success: boolean;
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

function baseSpawnOptions(options: CommandOptions) {
  return {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv | undefined,
    shell: options.shell ?? false,
  };
}

function collect(child: ChildProcess): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
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

/** `Deno.Command(...).output()` equivalent: run to completion, capture both
 * streams, never throw on a non-zero exit. */
export function commandOutput(
  command: string,
  options: CommandOptions = {},
): Promise<CommandOutput> {
  const child = spawn(command, options.args ?? [], {
    ...baseSpawnOptions(options),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return collect(child);
}

/** `Deno.Command(...).spawn()` then write to stdin: used by the `gh` client
 * to pass a JSON body with `--input -`. */
export function commandWithInput(
  command: string,
  options: CommandOptions,
  input: string,
): Promise<CommandOutput> {
  const child = spawn(command, options.args ?? [], {
    ...baseSpawnOptions(options),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.end(input);
  return collect(child);
}

/** A spawned process that can be killed on timeout, mirroring
 * `Deno.Command(...).spawn()` + `proc.kill()`. */
export function commandSpawn(
  command: string,
  options: CommandOptions = {},
): {
  kill: (signal?: NodeJS.Signals) => void;
  output: () => Promise<CommandOutput>;
} {
  const child = spawn(command, options.args ?? [], {
    ...baseSpawnOptions(options),
    stdio: [options.stdin === "piped" ? "pipe" : "ignore", "pipe", "pipe"],
  });
  return {
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      try {
        child.kill(signal);
      } catch {
        // already exited
      }
    },
    output: () => collect(child),
  };
}

/** Whether `pid` names a live process.
 *
 * Windows: `process.kill(pid, 0)` is unreliable (Node emulates signals and
 * would terminate the target), so `tasklist` answers without touching it.
 * POSIX: signal 0 checks existence without delivering; `ESRCH` means dead,
 * while `EPERM` (or anything else) means it exists but is not ours — assume
 * alive rather than risk two writers on the same database. */
/** Decides Windows PID liveness from a `tasklist` invocation. A matching row is
 * CSV and starts with the quoted image name; the "no tasks" notice is prose, so
 * the distinction is locale-independent. A spawn failure or an empty body is
 * indeterminate and reports alive: refusing to start beats letting a second
 * writer take over a live lock. */
export function livenessFromTasklist(result: {
  error?: unknown;
  stdout?: string | null;
}): boolean {
  if (result.error) return true;
  const out = (result.stdout ?? "").trim();
  if (out === "") return true;
  return out.startsWith('"');
}

export function isProcessAlive(pid: number): boolean {
  if (isWindows()) {
    const result = spawnSync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      {
        encoding: "utf8",
      },
    );
    return livenessFromTasklist(result);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH";
  }
}
