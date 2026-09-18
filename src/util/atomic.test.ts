import { cleanStaleTempFiles, writeTextFileAtomic } from "./atomic.ts";
import {
  readDir,
  readTextFile,
  removePath,
  tempDir,
  writeTextFile,
} from "../testing/runtime.ts";
import { test } from "node:test";

test("atomic: interrupted write leaves original", async () => {
  const dir = await tempDir();
  const path = `${dir}/guide.md`;
  await writeTextFile(path, "before");
  const stale = `${dir}/.guide.md.tmp-stale`;
  await writeTextFile(stale, "half");
  await writeTextFileAtomic(path, "after");
  const text = await readTextFile(path);
  if (text !== "after") throw new Error(`expected after, got ${text}`);
  await removePath(dir, { recursive: true });
});

test("atomic: cleans stale temp files", async () => {
  const dir = await tempDir();
  const path = `${dir}/out.txt`;
  await writeTextFile(`${dir}/.out.txt.tmp-old`, "junk");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await cleanStaleTempFiles(dir, "out.txt", 0);
  await writeTextFileAtomic(path, "ok");
  let foundStale = false;
  for await (const entry of readDir(dir)) {
    if (entry.name.startsWith(".out.txt.tmp-")) foundStale = true;
  }
  if (foundStale) throw new Error("stale temp file was not cleaned");
  await removePath(dir, { recursive: true });
});

test("atomic: rename replaces existing file on Windows", async () => {
  const dir = await tempDir();
  const path = `${dir}/target.md`;
  await writeTextFile(path, "v1");
  await writeTextFileAtomic(path, "v2");
  const text = await readTextFile(path);
  if (text !== "v2") throw new Error(`expected v2, got ${text}`);
  await cleanStaleTempFiles(dir, "target.md");
  await removePath(dir, { recursive: true });
});
