/** Downgrade check (CORE-05).
 *
 *   npm run downgrade:check
 *
 * Proves a user can move forward and then back: the branch's code writes a
 * config.json, a cache.db via `init` and an app.db via `serve`, and then the
 * published 0.4.13 release runs against those exact directories and exits 0 on
 * every step. A forward-only app.db migration that refuses the older binary is
 * the failure this catches.
 *
 * POSIX only. 0.4.13 has no `gh` override (the branch added `CM_GH_BIN` for
 * exactly that reason) and Node cannot spawn a `.cmd` through PATH without a
 * shell, so on Windows neither the fake `gh` nor the `npx` launcher is
 * reachable. The plan wires this to its own ubuntu CI job for the same reason;
 * on Windows the script reports the skip instead of pretending to pass.
 */
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  chmod,
  commandSpawn,
  isWindows,
  makeTempDir,
  mkdir,
  remove,
  writeTextFile,
} from "../src/util/runtime.ts";
import { runtimeExecPath, runtimeRunArgs } from "../src/testing/runtime.ts";

const OLD_VERSION = "0.4.13";
const PASSWORD = "downgrade-check-pass";
const REPO = "fixture/repo";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const fakeGh = join(projectRoot, "src/testing/fake_gh/gh.mjs");

/** Locate `npm-cli.js` without a shell. `npx` is a shell script or `.cmd`, and
 * the argument-escaping and Windows-spawn problems that brings are why this
 * script runs the npm CLI on `process.execPath` instead. The layout differs:
 * the Windows installer puts npm under `nodejs/node_modules`, while
 * `actions/setup-node` puts it under the sibling `nodejs/lib`. */
function findNpmCli(): string {
  const binDir = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    join(binDir, "node_modules/npm/bin/npm-cli.js"),
    join(binDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `could not locate npm-cli.js; tried:\n${candidates.join("\n")}`,
    );
  }
  return found;
}

const npmCli = findNpmCli();

type RunResult = { ok: boolean; code: number; stdout: string; stderr: string };

const steps: { step: string; ok: boolean; detail: string }[] = [];
const skips: string[] = [];

function record(step: string, ok: boolean, detail = ""): void {
  steps.push({ step, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${step}${detail ? ` · ${detail}` : ""}`);
}

function recordSkip(step: string, reason: string): void {
  skips.push(`${step} (${reason})`);
  console.log(`skip ${step} · ${reason}`);
}

async function run(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 180_000,
): Promise<RunResult> {
  const child = commandSpawn(command, {
    args,
    cwd: projectRoot,
    env,
    stdout: "piped",
    stderr: "piped",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    child.output(),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(undefined);
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!result) return { ok: false, code: 124, stdout: "", stderr: "timed out" };
  return {
    ok: result.success,
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      // A bare `fetch` has no timeout, so a server that accepts the connection
      // and never answers would hang this poll forever. `AbortSignal.any`
      // gives each request its own 5s deadline while still ending the poll the
      // moment the child exits.
      if (
        (
          await fetch(url, {
            signal: AbortSignal.any(
              [signal, AbortSignal.timeout(5_000)].filter(
                (item): item is AbortSignal => item !== undefined,
              ),
            ),
          })
        ).status === 200
      ) {
        return true;
      }
    } catch {
      // not listening yet, aborted, or timed out
    }
    await sleep(200);
  }
  return false;
}

/** Starts `serve` via `command` + `prefixArgs`, waits for a healthy
 * `/api/health`, then stops it. `serve` only exits on a signal, so the kill
 * must come before the output is read. Output collection starts at spawn
 * because a child that crashes early would otherwise have closed before
 * `output()` attaches its listeners, and the await would never settle. */
async function serveAndStop(
  command: string,
  prefixArgs: string[],
  extraEnv: Record<string, string | undefined>,
): Promise<{ up: boolean; detail: string }> {
  const port = await freePort();
  const child = commandSpawn(command, {
    args: [...prefixArgs, "serve", `--port=${port}`, `--password=${PASSWORD}`],
    cwd: projectRoot,
    env: extraEnv,
    stdout: "piped",
    stderr: "piped",
  });
  const outputPromise = child.output().catch(() => undefined);
  // Aborting ends the health poll when the child exits first, so it does not
  // keep hitting a dead port behind the race.
  const healthAbort = new AbortController();
  // A crash must fail fast with its own stderr, not wait out the timeout.
  const outcome = await Promise.race([
    waitForHealth(
      `http://127.0.0.1:${port}/api/health`,
      90_000,
      healthAbort.signal,
    ).then((up) => (up ? "up" : "timeout")),
    outputPromise.then(() => "exited"),
  ]);
  healthAbort.abort();
  // Stop the server before waiting on its output. A healthy or timed-out
  // `serve` only exits on this signal, so awaiting `outputPromise` first would
  // hang the whole check; only the "exited" branch already has it settled.
  child.kill("SIGTERM");
  const result = await outputPromise;
  if (outcome === "up") return { up: true, detail: "" };
  const stderr = result ? new TextDecoder().decode(result.stderr).trim() : "";
  const stdout = result ? new TextDecoder().decode(result.stdout).trim() : "";
  const tail = stderr || stdout;
  if (outcome === "exited" && stderr) {
    console.error(`--- serve stderr ---\n${stderr}`);
  }
  return {
    up: false,
    detail:
      outcome === "exited"
        ? `serve exited: ${tail.slice(0, 400)}`
        : `serve never became healthy. ${tail.slice(0, 400)}`,
  };
}

function sandboxEnv(sandbox: string): Record<string, string | undefined> {
  return {
    ...process.env,
    CM_CONFIG_PATH: join(sandbox, "config.json"),
    CM_REPOS_DIR: join(sandbox, "repos"),
    CM_APP_DB: join(sandbox, "app.db"),
    CM_CLONES_DIR: join(sandbox, "clones"),
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_DATA_HOME: join(sandbox, "data"),
  };
}

const sandbox = await makeTempDir({ prefix: "cm-downgrade-" });
const env = sandboxEnv(sandbox);

try {
  // A `gh` on PATH that runs the shared fake. 0.4.13 has no override hook, so
  // this is the only way to keep its `remake` off the network.
  const ghDir = join(sandbox, "bin");
  await mkdir(ghDir, { recursive: true });
  await writeTextFile(
    join(ghDir, "gh"),
    `#!/bin/sh\nexec "${process.execPath}" "${fakeGh}" "$@"\n`,
  );
  await chmod(join(ghDir, "gh"), 0o755);
  const pathWithFakeGh = `${ghDir}:${process.env.PATH ?? ""}`;

  // --- 1. The branch's code writes the state a downgrade will read. ---
  const init = await run(
    runtimeExecPath(),
    runtimeRunArgs("main.ts", [
      "init",
      REPO,
      "--ai=none",
      "--auth=gh",
      "--include-codebase",
      "--include-pull-requests",
      "--include-commit-history",
    ]),
    {
      ...env,
      CM_FAKE_AI: "1",
      CM_GH_BIN: runtimeExecPath(),
      CM_GH_SCRIPT: fakeGh,
    },
  );
  if (!init.ok) {
    throw new Error(`branch init exited ${init.code}: ${init.stderr}`);
  }
  const config = JSON.parse(await readFile(env.CM_CONFIG_PATH!, "utf8")) as {
    repos?: Record<string, unknown>;
  };
  record(
    "branch init wrote config.json, repos and cache.db",
    Boolean(config.repos?.[REPO]),
    `${Object.keys(config).length} top-level keys`,
  );

  const current = await serveAndStop(
    runtimeExecPath(),
    runtimeRunArgs("main.ts", []),
    { ...env, CM_FAKE_AI: "1" },
  );
  record(
    "branch serve opened app.db and answered /api/health",
    current.up,
    current.detail,
  );
  if (!current.up) throw new Error("the branch's own serve is not healthy");

  // --- 2. 0.4.13 runs against the same directories. ---
  // Install into a fixed prefix and launch `dist/main.js` on this Node, not
  // through `npx`: `npx` is a `.cmd` (unspawnable without a shell) and on
  // Windows it also spawns the CLI as a detached grandchild, so killing the
  // wrapper would leave `serve` listening and hang the run.
  const oldPrefix = join(sandbox, "old");
  const install = await run(
    process.execPath,
    [
      npmCli,
      "install",
      "--prefix",
      oldPrefix,
      "--no-audit",
      "--no-fund",
      `co-maintainer@${OLD_VERSION}`,
    ],
    env,
  );
  if (!install.ok) {
    throw new Error(`installing ${OLD_VERSION} failed: ${install.stderr}`);
  }
  const oldEntry = join(
    oldPrefix,
    "node_modules",
    "co-maintainer",
    "dist",
    "main.js",
  );

  const version = await run(process.execPath, [oldEntry, "--version"], env);
  record(
    "0.4.13 --version exits 0",
    version.ok && version.stdout.trim().startsWith(OLD_VERSION),
    version.stdout.trim() || version.stderr.trim(),
  );

  const set = await run(
    process.execPath,
    [
      oldEntry,
      "set",
      "--ai=none",
      "--auth=gh",
      "--low-model=test/low",
      "--high-model=test/high",
    ],
    env,
  );
  record(
    "0.4.13 set exits 0",
    set.ok,
    set.ok ? set.stdout.trim() : set.stderr.trim(),
  );

  if (isWindows()) {
    recordSkip(
      "0.4.13 remake",
      "0.4.13 has no gh override and Node cannot spawn a .cmd through PATH",
    );
  } else {
    const remake = await run(process.execPath, [oldEntry, "remake", REPO], {
      ...env,
      CM_FAKE_AI: "1",
      PATH: pathWithFakeGh,
    });
    record(
      "0.4.13 remake exits 0 against the branch's cache.db",
      remake.ok,
      remake.ok ? "" : remake.stderr.trim().slice(0, 400),
    );
  }

  const oldServe = await serveAndStop(process.execPath, [oldEntry], env);
  record(
    "0.4.13 serve opened app.db and answered /api/health",
    oldServe.up,
    oldServe.detail,
  );

  const failures = steps.filter((step) => !step.ok);
  if (failures.length > 0) {
    throw new Error(
      `downgrade check failed:\n${failures
        .map((step) => `  ${step.step} · ${step.detail}`)
        .join("\n")}`,
    );
  }
  console.log(
    `downgrade check ok · ${steps.length} steps · 0.4.13 read the branch's config.json, cache.db and app.db`,
  );
  if (skips.length > 0) {
    console.log(
      `skipped ${skips.length} step(s), so this is a partial check · ${skips.join("; ")}`,
    );
  }
} finally {
  await remove(sandbox, { recursive: true }).catch(() => {});
}
