/** Downgrade check (CORE-05, CORE-102b).
 *
 *   npm run downgrade:check
 *
 * Proves a user can upgrade and then go back. The published 0.4.13 writes a
 * config.json, a cache.db and an app.db, the branch's code upgrades them (its
 * migration takes a backup first), `rollback` restores the backup, and 0.4.13
 * runs against the restored directories and exits 0 on every step. A release
 * refuses an app.db newer than it knows, so the way back is the backup, not the
 * old code opening the new database.
 *
 * POSIX only for the 0.4.13 `init`. 0.4.13 has no `gh` override (the branch
 * added `CM_GH_BIN` for exactly that reason) and Node cannot spawn a `.cmd`
 * through PATH without a shell, so on Windows that step is reported as a skip
 * instead of pretending to pass. The plan wires this to its own ubuntu CI job.
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

  // --- 1. The published release writes the state that gets upgraded. ---
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
      "0.4.13 init",
      "0.4.13 has no gh override and Node cannot spawn a .cmd through PATH",
    );
  } else {
    const oldInit = await run(
      process.execPath,
      [
        oldEntry,
        "init",
        REPO,
        "--ai=none",
        "--auth=gh",
        "--include-codebase",
        "--include-pull-requests",
        "--include-commit-history",
      ],
      { ...env, CM_FAKE_AI: "1", PATH: pathWithFakeGh },
    );
    record(
      "0.4.13 init wrote config.json, repos and cache.db",
      oldInit.ok,
      oldInit.ok ? "" : oldInit.stderr.trim().slice(0, 400),
    );
  }

  const oldFirst = await serveAndStop(process.execPath, [oldEntry], env);
  record(
    "0.4.13 serve created app.db and answered /api/health",
    oldFirst.up,
    oldFirst.detail,
  );
  if (!oldFirst.up) throw new Error("0.4.13's own serve is not healthy");
  const configBefore = await readFile(env.CM_CONFIG_PATH!, "utf8");

  // --- 2. The branch upgrades it: the migration must back up first. ---
  const upgraded = await serveAndStop(
    runtimeExecPath(),
    runtimeRunArgs("main.ts", []),
    { ...env, CM_FAKE_AI: "1" },
  );
  record(
    "branch serve migrated app.db and answered /api/health",
    upgraded.up,
    upgraded.detail,
  );
  if (!upgraded.up) throw new Error("the branch's serve is not healthy");
  record(
    "the upgrade left a backup",
    existsSync(join(sandbox, "backups", "previous", "manifest.json")),
  );

  // Data the upgrade writes, which the rollback is meant to discard.
  const branchInit = await run(
    runtimeExecPath(),
    runtimeRunArgs("main.ts", [
      "init",
      REPO,
      "--ai=none",
      "--auth=gh",
      "--include-codebase",
    ]),
    {
      ...env,
      CM_FAKE_AI: "1",
      CM_GH_BIN: runtimeExecPath(),
      CM_GH_SCRIPT: fakeGh,
    },
  );
  record(
    "branch init runs after the upgrade",
    branchInit.ok,
    branchInit.ok ? "" : branchInit.stderr.trim().slice(0, 400),
  );

  // --- 3. Rolling back puts the old data back and 0.4.13 runs again. ---
  const rollback = await run(
    runtimeExecPath(),
    runtimeRunArgs("main.ts", ["rollback", "--yes"]),
    env,
  );
  record(
    "branch rollback restored the backup",
    rollback.ok,
    rollback.ok ? "" : rollback.stderr.trim().slice(0, 400),
  );
  const configAfter = JSON.parse(
    await readFile(env.CM_CONFIG_PATH!, "utf8"),
  ) as Record<string, unknown>;
  const configWas = JSON.parse(configBefore) as Record<string, unknown>;
  const changed = [
    ...new Set([...Object.keys(configWas), ...Object.keys(configAfter)]),
  ]
    .filter(
      // `serve --password=` re-salts the stored hash on every start, before the
      // migration takes its backup, so the hash differs while the password is the same.
      (key) => key !== "dashboardPasswordHash",
    )
    .filter(
      (key) =>
        JSON.stringify(configWas[key]) !== JSON.stringify(configAfter[key]),
    );
  record(
    "rollback restored config.json",
    changed.length === 0,
    changed.length ? `differs in: ${changed.join(", ")}` : "",
  );

  const oldAgain = await serveAndStop(process.execPath, [oldEntry], env);
  record(
    "0.4.13 serve opened the restored app.db and answered /api/health",
    oldAgain.up,
    oldAgain.detail,
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
    `downgrade check ok · ${steps.length} steps · the branch backed up, rolled back, and 0.4.13 ran on the restored data`,
  );
  if (skips.length > 0) {
    console.log(
      `skipped ${skips.length} step(s), so this is a partial check · ${skips.join("; ")}`,
    );
  }
} finally {
  await remove(sandbox, { recursive: true }).catch(() => {});
}
