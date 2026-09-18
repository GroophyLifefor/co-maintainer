/** Behavior of the runtime shim that the rest of the code silently depends on:
 * temp-file shape, the platform vocabulary, and how an indeterminate PID probe
 * is resolved. */
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  currentPlatform,
  isProcessAlive,
  livenessFromTasklist,
  makeTempFile,
  remove,
  stat,
} from "./runtime.ts";
import { test } from "node:test";

test("makeTempFile creates the file directly in the temp dir", async () => {
  const file = await makeTempFile({ prefix: "cm-test-", suffix: ".json" });
  try {
    // Deno.makeTempFile puts a single file under the temp dir. Creating a
    // dedicated mkdtemp directory instead leaves that directory behind, since
    // callers only remove the returned file.
    if (dirname(file) !== tmpdir()) {
      throw new Error(`file was placed in ${dirname(file)}, not ${tmpdir()}`);
    }
    if (!(await stat(file)).isFile()) throw new Error("not a file");
  } finally {
    await remove(file).catch(() => {});
  }
});

test("currentPlatform stays in its vocabulary for every platform", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", {
      value: "freebsd",
      configurable: true,
    });
    // Deliberate fallback: a Node platform outside the vocabulary keeps the
    // Linux/XDG paths rather than failing to start.
    if (currentPlatform() !== "linux") {
      throw new Error(`unexpected platform: ${currentPlatform()}`);
    }
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
});

test("livenessFromTasklist reads a matched row as alive", () => {
  const alive = livenessFromTasklist({
    error: null,
    stdout: '"co-maintainer.exe","16304","Console","1","10,000 K"',
  });
  if (!alive) throw new Error("a matched row should be alive");
});

test("livenessFromTasklist reads 'no tasks' as dead", () => {
  const alive = livenessFromTasklist({
    error: null,
    stdout: "INFO: No tasks are running which match the specified criteria.",
  });
  if (alive) throw new Error("an explicit no-match should be dead");
});

test("livenessFromTasklist fails closed when tasklist is unusable", () => {
  // Two writers on one SQLite file is worse than refusing to start, so an
  // indeterminate probe must report alive.
  for (const result of [
    { error: new Error("spawn tasklist ENOENT"), stdout: null },
    { error: new Error("spawn tasklist ENOENT"), stdout: "" },
    { error: null, stdout: null },
    { error: null, stdout: "" },
  ]) {
    if (!livenessFromTasklist(result)) {
      throw new Error(
        `indeterminate probe read as dead: ${JSON.stringify(result)}`,
      );
    }
  }
});

test("isProcessAlive sees this test process as alive", () => {
  if (!isProcessAlive(process.pid)) {
    throw new Error("this process must be alive");
  }
});
