import { basename, dirname } from "node:path";

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
    for await (const entry of Deno.readDir(directory)) {
      if (!entry.isFile || !entry.name.startsWith(prefix)) continue;
      const path = `${directory}/${entry.name}`;
      const stat = await Deno.stat(path);
      const mtime = stat.mtime?.getTime() ?? 0;
      if (mtime > cutoff) continue;
      await Deno.remove(path).catch(() => {});
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Windows `rename` does not replace an existing file; swap via a backup
 * name so a failed promote can restore the previous contents. */
async function promoteTempOnWindows(temp: string, path: string): Promise<void> {
  if (!(await pathExists(path))) {
    await Deno.rename(temp, path);
    return;
  }
  const backup = `${path}.atomic-backup`;
  await Deno.remove(backup).catch(() => {});
  await Deno.rename(path, backup);
  try {
    await Deno.rename(temp, path);
  } catch (error) {
    await Deno.rename(backup, path).catch(() => {});
    throw error;
  }
  await Deno.remove(backup).catch(() => {});
}

/** Write then rename into place so readers never see a half-written file. */
async function recoverWindowsAtomicBackup(path: string): Promise<void> {
  if (Deno.build.os !== "windows") return;
  const backup = `${path}.atomic-backup`;
  if (!(await pathExists(path)) && (await pathExists(backup))) {
    await Deno.rename(backup, path);
  }
}

export async function writeTextFileAtomic(
  path: string,
  text: string,
): Promise<void> {
  await recoverWindowsAtomicBackup(path);
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const base = basename(path);
  const temp = tempName(dir, base);
  await Deno.writeTextFile(temp, text);
  if (Deno.build.os === "windows") {
    await promoteTempOnWindows(temp, path);
  } else {
    await Deno.rename(temp, path);
  }
}
