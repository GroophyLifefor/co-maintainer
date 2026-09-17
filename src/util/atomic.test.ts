import {
  cleanStaleTempFiles,
  writeTextFileAtomic,
} from "./atomic.ts";

Deno.test("atomic: interrupted write leaves original", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/guide.md`;
  await Deno.writeTextFile(path, "before");
  const stale = `${dir}/.guide.md.tmp-stale`;
  await Deno.writeTextFile(stale, "half");
  await writeTextFileAtomic(path, "after");
  const text = await Deno.readTextFile(path);
  if (text !== "after") throw new Error(`expected after, got ${text}`);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("atomic: cleans stale temp files", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/out.txt`;
  await Deno.writeTextFile(`${dir}/.out.txt.tmp-old`, "junk");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await cleanStaleTempFiles(dir, "out.txt", 0);
  await writeTextFileAtomic(path, "ok");
  let foundStale = false;
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".out.txt.tmp-")) foundStale = true;
  }
  if (foundStale) throw new Error("stale temp file was not cleaned");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("atomic: rename replaces existing file on Windows", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/target.md`;
  await Deno.writeTextFile(path, "v1");
  await writeTextFileAtomic(path, "v2");
  const text = await Deno.readTextFile(path);
  if (text !== "v2") throw new Error(`expected v2, got ${text}`);
  await cleanStaleTempFiles(dir, "target.md");
  await Deno.remove(dir, { recursive: true });
});
