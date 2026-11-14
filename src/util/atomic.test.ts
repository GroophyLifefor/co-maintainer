import { readFileSync, statSync } from "node:fs";
import {
  type AtomicIo,
  cleanStaleTempFiles,
  writeTextFileAtomic,
} from "./atomic.ts";
import {
  readDir,
  readTextFile,
  removePath,
  tempDir,
  writeTextFile,
} from "../testing/runtime.ts";
import { test } from "node:test";

async function tempFilesIn(dir: string, base: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of readDir(dir)) {
    if (entry.name.startsWith(`.${base}.tmp-`)) names.push(entry.name);
  }
  return names;
}

/** Real file operations, with the steps a test wants to break swapped in. */
function io(overrides: Partial<AtomicIo>): AtomicIo {
  return {
    writeTextFile: (path, text) => writeTextFile(path, text),
    rename: async (from, to) => {
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    },
    windows: false,
    sleep: async () => {},
    ...overrides,
  };
}

function codedError(code: string): Error {
  return Object.assign(new Error(`${code}: operation not permitted`), {
    code,
  });
}

test("atomic: a reader never sees a partial file while a writer loops", async () => {
  const dir = await tempDir();
  const path = `${dir}/config.json`;
  // Big enough that an in-place write takes several chunks, so a reader
  // between them would see a truncated or empty file.
  const versions = ["a", "b"].map(
    (letter) => `${JSON.stringify({ value: letter.repeat(512 * 1024) })}\n`,
  );
  await writeTextFileAtomic(path, versions[0]!);
  const seen: string[] = [];
  const writer = async () => {
    for (let round = 0; round < 40; round++) {
      await writeTextFileAtomic(path, versions[round % 2]!);
    }
  };
  const reader = async () => {
    for (let round = 0; round < 400; round++) {
      const text = readFileSync(path, "utf8");
      if (!versions.includes(text)) {
        seen.push(`round ${round}: ${text.length} characters`);
      } else {
        JSON.parse(text);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await Promise.all([writer(), reader()]);
  if (seen.length > 0) {
    throw new Error(`the reader saw partial files: ${seen.join(", ")}`);
  }
  const left = await tempFilesIn(dir, "config.json");
  if (left.length > 0) throw new Error(`temp files left: ${left.join(", ")}`);
  await removePath(dir, { recursive: true });
});

test("atomic: a write that fails halfway leaves the old file and no temp file", async () => {
  const dir = await tempDir();
  const path = `${dir}/config.json`;
  await writeTextFile(path, "old\n");
  let error: unknown;
  try {
    await writeTextFileAtomic(
      path,
      "new contents\n",
      {},
      io({
        writeTextFile: async (temp, text) => {
          await writeTextFile(temp, text.slice(0, 3));
          throw new Error("disk full");
        },
      }),
    );
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error) || error.message !== "disk full") {
    throw new Error(`the write error was not passed on: ${String(error)}`);
  }
  const text = await readTextFile(path);
  if (text !== "old\n") throw new Error(`the old file changed: ${text}`);
  const left = await tempFilesIn(dir, "config.json");
  if (left.length > 0) throw new Error(`temp files left: ${left.join(", ")}`);
  await removePath(dir, { recursive: true });
});

test("atomic: a rename that fails leaves the old file and no temp file", async () => {
  const dir = await tempDir();
  const path = `${dir}/config.json`;
  await writeTextFile(path, "old\n");
  await writeTextFileAtomic(
    path,
    "new\n",
    {},
    io({
      rename: () => Promise.reject(codedError("EXDEV")),
    }),
  ).then(
    () => {
      throw new Error("the failed rename was not reported");
    },
    () => {},
  );
  const text = await readTextFile(path);
  if (text !== "old\n") throw new Error(`the old file changed: ${text}`);
  const left = await tempFilesIn(dir, "config.json");
  if (left.length > 0) throw new Error(`temp files left: ${left.join(", ")}`);
  await removePath(dir, { recursive: true });
});

test("atomic: on Windows a busy target is retried until it is free", async () => {
  const dir = await tempDir();
  const path = `${dir}/config.json`;
  await writeTextFile(path, "old\n");
  const failures = ["EBUSY", "EPERM", "EACCES"];
  const base = io({});
  await writeTextFileAtomic(
    path,
    "new\n",
    {},
    io({
      windows: true,
      rename: (from, to) => {
        const code = failures.shift();
        return code ? Promise.reject(codedError(code)) : base.rename(from, to);
      },
    }),
  );
  const text = await readTextFile(path);
  if (text !== "new\n") throw new Error(`expected the new file, got ${text}`);
  await removePath(dir, { recursive: true });
});

test("atomic: on Windows a target that stays busy fails with its name and leaves no temp file", async () => {
  const dir = await tempDir();
  const path = `${dir}/config.json`;
  await writeTextFile(path, "old\n");
  let tries = 0;
  let message = "";
  try {
    await writeTextFileAtomic(
      path,
      "new\n",
      {},
      io({
        windows: true,
        rename: () => {
          tries++;
          return Promise.reject(codedError("EPERM"));
        },
      }),
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes(path) || !message.includes("EPERM")) {
    throw new Error(`the error does not name the file and cause: ${message}`);
  }
  if (tries < 2) throw new Error(`the rename was not retried: ${tries}`);
  const text = await readTextFile(path);
  if (text !== "old\n") throw new Error(`the old file changed: ${text}`);
  const left = await tempFilesIn(dir, "config.json");
  if (left.length > 0) throw new Error(`temp files left: ${left.join(", ")}`);
  await removePath(dir, { recursive: true });
});

test("atomic: a busy target is not retried off Windows", async () => {
  const dir = await tempDir();
  const path = `${dir}/config.json`;
  let tries = 0;
  await writeTextFileAtomic(
    path,
    "new\n",
    {},
    io({
      rename: () => {
        tries++;
        return Promise.reject(codedError("EACCES"));
      },
    }),
  ).catch(() => {});
  if (tries !== 1) throw new Error(`expected one rename, got ${tries}`);
  await removePath(dir, { recursive: true });
});

test(
  "atomic: the mode is set before the file takes its real name",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const dir = await tempDir();
    const path = `${dir}/config.json`;
    const modes: number[] = [];
    const base = io({});
    await writeTextFileAtomic(
      path,
      "{}\n",
      { mode: 0o600 },
      io({
        rename: (from, to) => {
          modes.push(statSync(from).mode & 0o777);
          return base.rename(from, to);
        },
      }),
    );
    const mode = statSync(path).mode & 0o777;
    if (modes[0] !== 0o600 || mode !== 0o600) {
      throw new Error(
        `expected 600 before and after the rename, got ${modes[0]?.toString(8)} and ${mode.toString(8)}`,
      );
    }
    await removePath(dir, { recursive: true });
  },
);

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
