import { basename, dirname } from "node:path";
import {
  chmod,
  isNotFound,
  isWindows,
  mkdir,
  readDir,
  remove,
  rename,
  stat,
  writeTextFile,
} from "../util/runtime.ts";

function tempName(dir: string, base: string): string {
  return `${dir}/.${base}.tmp-${crypto.randomUUID()}`;
}

/** Remove leftover `.<name>.tmp-*` files from an interrupted write.
 * Only deletes temps older than `minAgeMs` so concurrent writers are not disturbed. */
export async function cleanStaleTempFiles(
  directory: string,
  baseName: string,
  minAgeMs = 60_000,
): Promise<void> {
  const prefix = `.${baseName}.tmp-`;
  const cutoff = Date.now() - minAgeMs;
  try {
    for await (const entry of readDir(directory)) {
      if (!entry.isFile || !entry.name.startsWith(prefix)) continue;
      const path = `${directory}/${entry.name}`;
      const info = await stat(path);
      const mtime = info.mtimeMs;
      if (mtime > cutoff) continue;
      await remove(path).catch(() => {});
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Older releases replaced a file on Windows by moving it to a backup name
 * first. A run killed between the two renames left only the backup, so put it
 * back before writing. */
async function recoverWindowsAtomicBackup(path: string): Promise<void> {
  if (!isWindows()) return;
  const backup = `${path}.atomic-backup`;
  if (!(await pathExists(path)) && (await pathExists(backup))) {
    await rename(backup, path);
  }
}

/** The file operations a write goes through. Tests pass their own to make a
 * step fail, or to play Windows on another platform. */
export type AtomicIo = {
  writeTextFile: (path: string, text: string, mode?: number) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  windows: boolean;
  sleep: (ms: number) => Promise<void>;
};

const defaultIo: AtomicIo = {
  writeTextFile: (path, text, mode) =>
    writeTextFile(path, text, mode === undefined ? undefined : { mode }),
  rename,
  windows: isWindows(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** How long a Windows rename waits between tries when another program holds
 * the target open. About a second in all, enough for a reader or a virus
 * scanner to let go, short enough that a stuck file fails the command. */
const WINDOWS_RENAME_DELAYS_MS = [10, 20, 40, 80, 160, 320, 400];

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** Node's rename replaces an existing file on every platform. On Windows it
 * fails with EPERM, EBUSY or EACCES while another program has the target open
 * without delete sharing, which a reader or a virus scanner can do for a
 * moment. Those are retried briefly, then reported with the file's name. */
async function replaceWithRetry(
  io: AtomicIo,
  temp: string,
  path: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await io.rename(temp, path);
      return;
    } catch (error) {
      const code = errorCode(error);
      const busy = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!io.windows || !busy) throw error;
      const delay = WINDOWS_RENAME_DELAYS_MS[attempt];
      if (delay === undefined) {
        throw new Error(
          `Could not replace ${path}: another program keeps it open (${code}). Close it and try again.`,
          { cause: error },
        );
      }
      await io.sleep(delay);
    }
  }
}

/** Writes a temp file beside `path`, then renames it over `path`, so a reader
 * in this or another process sees the old file or the new one, never half of
 * one. `mode` is set on the temp file before the rename, so the real file never
 * exists with a wider mode. The temp file is removed when any step fails. */
export async function writeTextFileAtomic(
  path: string,
  text: string,
  options: { mode?: number } = {},
  io: AtomicIo = defaultIo,
): Promise<void> {
  await recoverWindowsAtomicBackup(path);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = tempName(dir, basename(path));
  try {
    await io.writeTextFile(temp, text, options.mode);
    if (options.mode !== undefined) {
      // The mode given at creation is narrowed by the umask. chmod sets it
      // exactly. Windows has no POSIX modes, so a failure there is expected.
      await chmod(temp, options.mode).catch(() => {});
    }
    await replaceWithRetry(io, temp, path);
  } catch (error) {
    await remove(temp).catch(() => {});
    throw error;
  }
}
