import { toolsDir } from "../config.ts";
import { commandOutput, isWindows, mkdir, stat } from "../util/runtime.ts";
import { askConfirm } from "../cli/prompt.ts";

/** The version co-maintainer is built against. codegraph's CLI output shape is
 * what the reviewer parses, so this is pinned rather than tracking latest: a
 * format change upstream must be an explicit upgrade here, not a surprise on
 * someone else's machine. Raise it, adjust whatever reads the output, done. */
export const CODEGRAPH_VERSION = "1.6.0";
export const CODEGRAPH_PACKAGE = "@colbymchenry/codegraph";

export type CommandResult = { code: number; stdout: string; stderr: string };
export type Runner = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

export type EnsureOptions = {
  /** Skips the prompt and installs. Set by `--allow-tool-install`. */
  allowInstall?: boolean;
  interactive?: boolean;
  run?: Runner;
  /** `node:readline/promises` made this async; both shapes are accepted. */
  confirm?: (question: string) => boolean | Promise<boolean>;
  log?: (message: string) => void;
  /** Overrides `toolsDir()`, for tests. */
  root?: string;
  /** Overrides `process.exit`, for tests. */
  exit?: (code: number) => never;
};

/** codegraph ships a small launcher plus a per-platform binary (an
 * `optionalDependencies` split), so the download a user is about to accept is
 * the platform package, not the tiny launcher. Measured from the npm registry
 * for {@link CODEGRAPH_VERSION}: ~249 MB unpacked on win32-x64. Kept as a
 * rounded figure because it moves between releases and the point is the order
 * of magnitude, not the exact byte count. */
export const CODEGRAPH_APPROX_SIZE = "~250 MB";

/** A prompt may only be shown when there is a human on the other end of stdin
 * *and* stdout, and no CI marker. A closed stdin (`</dev/null`), a piped
 * output, or `CI=1` must all take the non-interactive path: asking then would
 * hang on a question nobody can answer (F01). `stdout` is checked because a
 * prompt printed into a pipe is invisible.
 *
 * `streams` is injectable so the tests can stand in for a TTY without a real
 * terminal. */
export function canPrompt(
  streams: { stdin?: { isTTY?: boolean }; stdout?: { isTTY?: boolean } } = {
    stdin: process.stdin,
    stdout: process.stdout,
  },
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    streams.stdin?.isTTY === true && streams.stdout?.isTTY === true && !env.CI
  );
}

/** The one line a non-interactive run prints instead of asking (F01). It names
 * the reason and both ways forward, so a CI log explains itself. */
export function skippedNotice(version = CODEGRAPH_VERSION): string {
  return (
    `codegraph ${version} is not installed, reviewing without it. ` +
    "Pass --allow-tool-install to install it, or --disable-codegraph to skip this notice."
  );
}

/** What the install prompt says: the package and version, where it comes from,
 * what it is for, the approximate size, and the exact directory. A bare
 * "Install ...? [y/N]" left the user guessing (F01). */
export function installPrompt(version: string, root: string): string {
  return (
    `co-maintainer uses codegraph ${version} (${CODEGRAPH_PACKAGE} from npm, ${CODEGRAPH_APPROX_SIZE}) ` +
    "to follow calls between files while reviewing.\n" +
    `Install it into ${versionDir(version, root)} (your global PATH is not touched)?`
  );
}

export async function runCommand(
  command: string,
  args: string[],
): Promise<CommandResult> {
  // Windows resolves npm and other shims through the shell, not as bare exes.
  const windows = isWindows();
  const output = await commandOutput(windows ? "cmd" : command, {
    args: windows ? ["/c", command, ...args] : args,
    stdout: "piped",
    stderr: "piped",
  });
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/** One version per directory, so several can sit side by side and an upgrade
 * never half-overwrites a working install. */
export function versionDir(version: string, root = toolsDir()): string {
  return `${root}/codegraph/${version}`;
}

export function binaryPath(version: string, root = toolsDir()): string {
  const dir = versionDir(version, root);
  return isWindows()
    ? `${dir}/node_modules/.bin/codegraph.cmd`
    : `${dir}/node_modules/.bin/codegraph`;
}

/** codegraph prints a bare semver on `--version`, but be lenient: any leading
 * `v`, surrounding whitespace or trailing build text is tolerated so a future
 * release that decorates the line does not read as "not installed". */
export function parseVersion(stdout: string): string | undefined {
  // No `\b` before the number: a `v` prefix is a word character, so a boundary
  // would refuse to match the common `v1.6.0` spelling.
  const match = stdout.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match?.[1];
}

export type Presence =
  | { state: "ok"; version: string; path: string }
  | { state: "mismatch"; version: string; path: string }
  | { state: "missing" };

export async function detect(
  version = CODEGRAPH_VERSION,
  root = toolsDir(),
  run: Runner = runCommand,
): Promise<Presence> {
  const path = binaryPath(version, root);
  try {
    await stat(path);
  } catch {
    return { state: "missing" };
  }
  const result = await run(path, ["--version"]);
  const found = parseVersion(result.stdout) ?? parseVersion(result.stderr);
  if (!found) return { state: "missing" };
  return found === version
    ? { state: "ok", version: found, path }
    : { state: "mismatch", version: found, path };
}

export function installCommand(
  version = CODEGRAPH_VERSION,
  root = toolsDir(),
): { command: string; args: string[] } {
  return {
    command: "npm",
    args: [
      "install",
      `${CODEGRAPH_PACKAGE}@${version}`,
      "--prefix",
      versionDir(version, root),
      "--no-audit",
      "--no-fund",
    ],
  };
}

export function installHint(
  version = CODEGRAPH_VERSION,
  root = toolsDir(),
): string {
  const { command, args } = installCommand(version, root);
  return `${command} ${args.join(" ")}`;
}

async function defaultConfirm(question: string): Promise<boolean> {
  return await askConfirm(question);
}

/** Makes sure the pinned codegraph is available, asking first. Returns the path
 * to the binary, or exits: co-maintainer indexes the repository with it, so
 * declining is a decision not to run this command, not a degraded mode. */
export async function ensureCodegraph(
  options: EnsureOptions = {},
): Promise<string> {
  const root = options.root ?? toolsDir();
  const run = options.run ?? runCommand;
  const log = options.log ?? ((message: string) => console.log(message));
  // `canPrompt` is the single source of truth for "may we ask": stdin and
  // stdout must both be a TTY and `CI` must be unset.
  const interactive = options.interactive ?? canPrompt();
  // Annotated so TypeScript can see the calls below never return and keeps the
  // `Presence` narrowing intact.
  const exit: (code: number) => never = options.exit ?? process.exit;
  const present = await detect(CODEGRAPH_VERSION, root, run);

  if (present.state === "ok") return present.path;
  if (present.state === "mismatch") {
    log(
      `[codegraph] expected ${CODEGRAPH_VERSION} but found ${present.version} ` +
        `at ${present.path}; reinstalling the pinned version`,
    );
  }

  if (!options.allowInstall) {
    if (!interactive) {
      // This path exits rather than continuing, so it must not say "reviewing
      // without it"; it says how to proceed.
      log(
        `[codegraph] codegraph ${CODEGRAPH_VERSION} is not installed.\n` +
          `Run with --allow-tool-install, or install it yourself:\n  ${installHint(
            CODEGRAPH_VERSION,
            root,
          )}`,
      );
      exit(1);
    }
    const confirm = options.confirm ?? defaultConfirm;
    // `defaultConfirm` is async, so an unawaited call is always truthy and the
    // user's "no" was silently ignored. Await it before deciding.
    const approved = await confirm(installPrompt(CODEGRAPH_VERSION, root));
    if (!approved) {
      log("[codegraph] declined. Nothing was installed");
      exit(1);
    }
  }

  const { command, args } = installCommand(CODEGRAPH_VERSION, root);
  log(`[codegraph] installing ${CODEGRAPH_PACKAGE}@${CODEGRAPH_VERSION}`);
  await mkdir(versionDir(CODEGRAPH_VERSION, root), { recursive: true });
  const result = await run(command, args);
  if (result.code !== 0) {
    log(
      `[codegraph] install failed (exit ${result.code}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
    exit(1);
  }

  const after = await detect(CODEGRAPH_VERSION, root, run);
  if (after.state !== "ok") {
    log(
      `[codegraph] install finished but ${binaryPath(CODEGRAPH_VERSION, root)} is still not usable`,
    );
    exit(1);
  }
  log(`[codegraph] ready at ${after.path}`);
  return after.path;
}

/** Review paths must not call `Deno.exit` (plan §8.7, S13). */
export async function ensureCodegraphForReview(
  options: EnsureOptions = {},
): Promise<{ path: string } | { reason: string }> {
  const root = options.root ?? toolsDir();
  const run = options.run ?? runCommand;
  const log = options.log ?? ((message: string) => console.error(message));
  const interactive = options.interactive ?? canPrompt();
  const present = await detect(CODEGRAPH_VERSION, root, run);

  if (present.state === "ok") return { path: present.path };
  if (present.state === "mismatch") {
    log(
      `[codegraph] expected ${CODEGRAPH_VERSION} but found ${present.version}; reinstalling`,
    );
  }

  if (!options.allowInstall) {
    // Non-interactive: do not ask, review without it. The caller logs the
    // reason, so the run continues instead of hanging or exiting (F01).
    if (!interactive) {
      return { reason: skippedNotice() };
    }
    const confirm = options.confirm ?? defaultConfirm;
    // Same as `ensureCodegraph`: an unawaited async confirm is always truthy.
    const approved = await confirm(installPrompt(CODEGRAPH_VERSION, root));
    if (!approved) return { reason: "codegraph install declined" };
  }

  const { command, args } = installCommand(CODEGRAPH_VERSION, root);
  log(`[codegraph] installing ${CODEGRAPH_PACKAGE}@${CODEGRAPH_VERSION}`);
  await mkdir(versionDir(CODEGRAPH_VERSION, root), { recursive: true });
  const result = await run(command, args);
  if (result.code !== 0) {
    return {
      reason:
        result.stderr.trim() ||
        result.stdout.trim() ||
        `install failed (exit ${result.code})`,
    };
  }
  const after = await detect(CODEGRAPH_VERSION, root, run);
  if (after.state !== "ok") {
    return { reason: "install finished but the binary is still not usable" };
  }
  return { path: after.path };
}
