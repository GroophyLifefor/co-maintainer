import { basename, dirname } from "node:path";
import {
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

/** Windows `rename` does not replace an existing file; swap via a backup
 * name so a failed promote can restore the previous contents. */
async function promoteTempOnWindows(temp: string, path: string): Promise<void> {
  if (!(await pathExists(path))) {
    await rename(temp, path);
    return;
  }
  const backup = `${path}.atomic-backup`;
  await remove(backup).catch(() => {});
  await rename(path, backup);
  try {
    await rename(temp, path);
  } catch (error) {
    await rename(backup, path).catch(() => {});
    throw error;
  }
  await remove(backup).catch(() => {});
}

/** Write then rename into place so readers never see a half-written file. */
async function recoverWindowsAtomicBackup(path: string): Promise<void> {
  if (!isWindows()) return;
  const backup = `${path}.atomic-backup`;
  if (!(await pathExists(path)) && (await pathExists(backup))) {
    await rename(backup, path);
  }
}

export async function writeTextFileAtomic(
  path: string,
  text: string,
): Promise<void> {
  await recoverWindowsAtomicBackup(path);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const base = basename(path);
  const temp = tempName(dir, base);
  await writeTextFile(temp, text);
  if (isWindows()) {
    await promoteTempOnWindows(temp, path);
  } else {
    await rename(temp, path);
  }
}
