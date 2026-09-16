import { basename, dirname } from "node:path";

function tempName(dir: string, base: string): string {
  return `${dir}/.${base}.tmp-${crypto.randomUUID()}`;
}

/** Remove leftover `.<name>.tmp-*` files from an interrupted write. */
export async function cleanStaleTempFiles(
  directory: string,
  baseName: string,
): Promise<void> {
  const prefix = `.${baseName}.tmp-`;
  try {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isFile && entry.name.startsWith(prefix)) {
        await Deno.remove(`${directory}/${entry.name}`).catch(() => {});
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** Write then rename into place so readers never see a half-written file. */
export async function writeTextFileAtomic(
  path: string,
  text: string,
): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const base = basename(path);
  await cleanStaleTempFiles(dir, base);
  const temp = tempName(dir, base);
  await Deno.writeTextFile(temp, text);
  await Deno.rename(temp, path);
}
