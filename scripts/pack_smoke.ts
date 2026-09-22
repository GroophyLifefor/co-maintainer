/** Package smoke test: proves the published tarball runs, not just the repo.
 *
 *   npm run pack:smoke
 *
 * `npm pack` writes a tarball, we install it into a throwaway prefix, and run
 * the packaged bin with every config location pointed at temp dirs. Without
 * this, a missing `files` entry or a broken bin shim ships undetected: the
 * repo tests import `src/` directly and never touch the built artifact.
 *
 * Nothing here goes through a shell. On Windows a `.cmd` shim would need
 * `shell: true`, and Node concatenates shell arguments without escaping, so a
 * repo or temp path containing a space would silently break. Running the npm
 * CLI and the packaged entry through `process.execPath` sidesteps that.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { commandOutput, getEnv, isWindows } from "../src/util/runtime.ts";

const ROOT = new URL("../", import.meta.url);
// `pathname` stays percent-encoded, so a repo path with a space would resolve
// to a directory that does not exist. `fileURLToPath` decodes it correctly.
const rootPath = fileURLToPath(ROOT);

type Result = { ok: boolean; code: number; stdout: string; stderr: string };

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<Result> {
  const result = await commandOutput(command, {
    args,
    cwd: options.cwd,
    env: options.env,
  });
  return {
    ok: result.success,
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

/** Runs the npm CLI through the current Node binary. `npm_execpath` is set by
 * npm whenever this runs as a script, which is the documented path. A direct
 * `node scripts/pack_smoke.ts` has no such variable, so fall back to the npm
 * shim with a shell (the argument-escape caveat applies only to that path). */
function runNpm(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<Result> {
  const execPath = getEnv("npm_execpath");
  if (execPath) return run(process.execPath, [execPath, ...args], options);
  console.warn("npm_execpath is unset, falling back to the npm shim");
  return run(isWindows() ? "npm.cmd" : "npm", args, options);
}

/** Runs the installed bin shim. Windows shims are `cmd` batch files, so they
 * need cmd.exe. Calling it explicitly keeps arguments out of a shell string,
 * which `shell: true` would concatenate unescaped (Node DEP0190). */
function runShim(
  shim: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<Result> {
  if (isWindows()) {
    return run("cmd.exe", ["/c", shim, ...args], { env });
  }
  return run(shim, args, { env });
}

/** Every knob the CLI reads for where it keeps state. Pointing all of them at
 * the temp root guarantees the smoke run cannot read or write the real config,
 * repo guides or databases on the machine running it. */
function isolatedEnv(sandbox: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  env.CM_CONFIG_PATH = join(sandbox, "config", "config.json");
  env.CM_REPOS_DIR = join(sandbox, "repos");
  env.APPDATA = join(sandbox, "appdata");
  env.LOCALAPPDATA = join(sandbox, "localappdata");
  env.XDG_CONFIG_HOME = join(sandbox, "config");
  env.XDG_CACHE_HOME = join(sandbox, "cache");
  env.XDG_DATA_HOME = join(sandbox, "data");
  return env;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const sandbox = await mkdtemp(join(tmpdir(), "cm-pack-smoke-"));
let tarball: string | undefined;

try {
  const packed = await runNpm(["pack", "--silent"], { cwd: rootPath });
  if (!packed.ok) {
    throw new Error(`npm pack failed (${packed.code}): ${packed.stderr}`);
  }
  const name = packed.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!name) throw new Error(`npm pack printed no filename: ${packed.stdout}`);
  tarball = join(rootPath, name);
  console.log(`packed ${name}`);

  const installPrefix = join(sandbox, "install");
  const installed = await runNpm(
    ["install", "--prefix", installPrefix, "--no-audit", "--no-fund", tarball],
    { cwd: sandbox },
  );
  if (!installed.ok) {
    throw new Error(`install failed (${installed.code}): ${installed.stderr}`);
  }

  const entry = join(
    installPrefix,
    "node_modules",
    "co-maintainer",
    "dist",
    "main.js",
  );
  if (!(await exists(entry))) {
    throw new Error(`packaged entry missing: ${entry}`);
  }
  const shim = join(
    installPrefix,
    "node_modules",
    ".bin",
    isWindows() ? "co-maintainer.cmd" : "co-maintainer",
  );
  if (!existsSync(shim)) {
    throw new Error(`bin shim missing: ${shim}`);
  }

  const env = isolatedEnv(sandbox);

  // Invoke the installed bin, not `dist/main.js`, so a wrong `bin` mapping or
  // a broken shim fails here. On Windows the shim is a `.cmd`, which only runs
  // through cmd.exe.
  const version = await runShim(shim, ["--version"], env);
  if (!version.ok) {
    throw new Error(`--version exited ${version.code}: ${version.stderr}`);
  }
  const printed = version.stdout.trim();
  if (!/^\d+\.\d+\.\d+/.test(printed)) {
    throw new Error(`--version printed ${JSON.stringify(printed)}`);
  }
  console.log(`--version -> ${printed} (exit 0)`);

  const help = await runShim(shim, ["help"], env);
  if (!help.ok) {
    throw new Error(`help exited ${help.code}: ${help.stderr}`);
  }
  if (!help.stdout.trim()) throw new Error("help printed nothing");
  console.log("help -> exit 0");

  console.log("pack smoke ok");
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(sandbox, { recursive: true, force: true });
}
