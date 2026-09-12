import { toolsDir } from "../config.ts";

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
  confirm?: (question: string) => boolean;
  log?: (message: string) => void;
  /** Overrides `toolsDir()`, for tests. */
  root?: string;
};

export async function runCommand(
  command: string,
  args: string[],
): Promise<CommandResult> {
  // Windows resolves npm and other shims through the shell, not as bare exes.
  const windows = Deno.build.os === "windows";
  const output = await new Deno.Command(windows ? "cmd" : command, {
    args: windows ? ["/c", command, ...args] : args,
    stdout: "piped",
    stderr: "piped",
  }).output();
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
  return Deno.build.os === "windows"
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
    await Deno.stat(path);
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

function defaultConfirm(question: string): boolean {
  const answer = prompt(`${question} [y/N]`)?.trim().toLowerCase() ?? "";
  return answer === "y" || answer === "yes";
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
  const interactive = options.interactive ?? Deno.stdin.isTerminal();
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
      log(
        `[codegraph] co-maintainer needs codegraph ${CODEGRAPH_VERSION} to index the repository.\n` +
          `Run it with --allow-tool-install, or install it yourself:\n  ${
            installHint(CODEGRAPH_VERSION, root)
          }`,
      );
      Deno.exit(1);
    }
    const confirm = options.confirm ?? defaultConfirm;
    const approved = confirm(
      `co-maintainer needs codegraph ${CODEGRAPH_VERSION} to index the repository.\n` +
        `Install it into ${
          versionDir(CODEGRAPH_VERSION, root)
        } (your global PATH is not touched)?`,
    );
    if (!approved) {
      log("[codegraph] declined; nothing was installed");
      Deno.exit(1);
    }
  }

  const { command, args } = installCommand(CODEGRAPH_VERSION, root);
  log(`[codegraph] installing ${CODEGRAPH_PACKAGE}@${CODEGRAPH_VERSION}`);
  await Deno.mkdir(versionDir(CODEGRAPH_VERSION, root), { recursive: true });
  const result = await run(command, args);
  if (result.code !== 0) {
    log(
      `[codegraph] install failed (exit ${result.code}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
    Deno.exit(1);
  }

  const after = await detect(CODEGRAPH_VERSION, root, run);
  if (after.state !== "ok") {
    log(
      `[codegraph] install finished but ${
        binaryPath(CODEGRAPH_VERSION, root)
      } is still not usable`,
    );
    Deno.exit(1);
  }
  log(`[codegraph] ready at ${after.path}`);
  return after.path;
}
