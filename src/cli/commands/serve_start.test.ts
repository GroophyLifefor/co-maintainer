/** `serve` startup through the real process: a busy port fails once and
 * clearly without claiming it listens, and a fresh install points at /setup
 * on the right port. Each run gets its own sandbox so nothing touches the
 * machine's real config or databases. */
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import {
  commandOutput,
  commandSpawn,
  makeTempDir,
  remove,
} from "../../util/runtime.ts";
import { runtimeExecPath, runtimeRunArgs } from "../../testing/runtime.ts";
import { test } from "node:test";
import { isolateTestFile } from "../../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function sandbox(): Promise<{
  dir: string;
  env: Record<string, string | undefined>;
}> {
  const dir = await makeTempDir({ prefix: "cm-serve-start-" });
  return {
    dir,
    env: {
      ...process.env,
      CM_CONFIG_PATH: join(dir, "config.json"),
      CM_REPOS_DIR: join(dir, "repos"),
      CM_APP_DB: join(dir, "app.db"),
      CM_CLONES_DIR: join(dir, "clones"),
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_CACHE_HOME: join(dir, "cache"),
      XDG_DATA_HOME: join(dir, "data"),
      CM_LOGIN_HINT: undefined,
    },
  };
}

function hold(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === "object" && address ? address.port : 0,
      });
    });
  });
}

test("a busy port fails with one clear error and never says listening", async () => {
  const { dir, env } = await sandbox();
  const busy = await hold();
  try {
    const result = await commandOutput(runtimeExecPath(), {
      args: runtimeRunArgs("main.ts", [
        "serve",
        `--port=${busy.port}`,
        "--password=serve-start-pass",
      ]),
      cwd: ROOT,
      env,
      stdout: "piped",
      stderr: "piped",
    });
    const out = new TextDecoder().decode(result.stdout);
    const err = new TextDecoder().decode(result.stderr);
    if (result.success) throw new Error("serve exited 0 on a busy port");
    if (out.includes("listening") || out.includes("dashboard at")) {
      throw new Error(`serve claimed to listen on a busy port:\n${out}`);
    }
    const lines = err
      .split("\n")
      .filter((line) => line.includes(String(busy.port)));
    if (lines.length !== 1 || !/already in use/.test(lines[0]!)) {
      throw new Error(`want one "already in use" line, got:\n${err}`);
    }
    if (/\n\s+at /.test(err)) throw new Error(`a stack trace leaked:\n${err}`);
  } finally {
    busy.server.close();
    await remove(dir, { recursive: true }).catch(() => {});
  }
});

test("a fresh install prints the /setup address on the chosen port after it listens", async () => {
  const { dir, env } = await sandbox();
  const free = await hold();
  const port = free.port;
  await new Promise<void>((resolve) => free.server.close(() => resolve()));
  const serve = commandSpawn(runtimeExecPath(), {
    args: runtimeRunArgs("main.ts", [
      "serve",
      `--port=${port}`,
      "--password=serve-start-pass",
    ]),
    cwd: ROOT,
    env,
    stdout: "piped",
    stderr: "piped",
  });
  try {
    const deadline = Date.now() + 30_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        up = (await fetch(`http://127.0.0.1:${port}/login`)).status < 500;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!up) throw new Error("serve never came up");
  } finally {
    serve.kill("SIGTERM");
  }
  const result = await serve.output();
  const out = new TextDecoder().decode(result.stdout);
  await remove(dir, { recursive: true }).catch(() => {});
  const listening = out.indexOf(`listening on http://localhost:${port}`);
  const setup = out.indexOf(`finish setup at http://localhost:${port}/setup`);
  if (listening < 0) throw new Error(`no listening line:\n${out}`);
  if (setup < 0) throw new Error(`no /setup address on port ${port}:\n${out}`);
  if (out.includes("serve-start-pass"))
    throw new Error("the given password was echoed");
});
