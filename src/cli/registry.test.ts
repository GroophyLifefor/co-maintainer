/** Command registry, help and did-you-mean tests (CORE-20).
 *
 * The help is asserted through the real dispatch (`run`), not by calling the
 * renderers directly, because the bug this fixes was in *routing*: `review -h`
 * used to be an error and `serve --help` used to demand `--port`. A renderer
 * test would have passed while the CLI still misbehaved.
 */
import { test } from "node:test";
import { run, reportCliError } from "./main.ts";
import { VERSION } from "../version.ts";
import { die } from "./error.ts";
import {
  closest,
  levenshtein,
  renderCommandHelp,
  renderGlobalHelp,
  registryToMarkdown,
  unknownCommandMessage,
  unknownOptionMessage,
  visibleCommands,
} from "./commands/registry.ts";

type Captured = { stdout: string; stderr: string; exitCode: number };

/** Runs the CLI with `console` and `process.exit` stood down, so one test can
 * observe many help paths without tearing the runner down. */
async function capture(args: string[]): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  const previousExit = process.exit;
  const previousCode = process.exitCode;
  let exitCode: number | undefined;
  console.log = (...parts: unknown[]) => stdout.push(parts.join(" "));
  console.error = (...parts: unknown[]) => stderr.push(parts.join(" "));
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new ExitSentinel(code ?? 0);
  }) as typeof process.exit;
  process.exitCode = undefined;
  try {
    await run(args);
  } catch (thrown) {
    if (!(thrown instanceof ExitSentinel)) {
      reportCliError(thrown);
    }
  } finally {
    console.log = log;
    console.error = error;
    process.exit = previousExit;
    exitCode ??= process.exitCode;
    process.exitCode = previousCode;
  }
  return {
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
    exitCode: exitCode ?? 0,
  };
}

class ExitSentinel extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

test("registry: levenshtein is the standard distance", () => {
  if (levenshtein("probe", "probe") !== 0) throw new Error("equal");
  if (levenshtein("prob", "probe") !== 1) throw new Error("one insert");
  if (levenshtein("", "abc") !== 3) throw new Error("empty prefix");
  if (levenshtein("kitten", "sitting") !== 3) throw new Error("classic case");
});

test("registry: closest only suggests within the distance limit", () => {
  if (closest("prob", ["probe", "init"]) !== "probe") throw new Error("near");
  if (closest("zzzz", ["probe", "init"]) !== undefined) throw new Error("far");
});

test("registry: did-you-mean for commands and flags", () => {
  if (unknownCommandMessage("prob") !== "Unknown command: prob. Did you mean probe?") {
    throw new Error(`command suggestion: ${unknownCommandMessage("prob")}`);
  }
  if (/Did you mean/.test(unknownCommandMessage("zzzz"))) {
    throw new Error("a far command should get no suggestion");
  }
  if (unknownOptionMessage("--jsno") !== "Unknown option: --jsno. Did you mean --json?") {
    throw new Error(`flag suggestion: ${unknownOptionMessage("--jsno")}`);
  }
  if (/Did you mean/.test(unknownOptionMessage("--totally-unrelated"))) {
    throw new Error("a far flag should get no suggestion");
  }
});

test("registry: every visible command documents its usage and has no dupes", () => {
  const names = new Set<string>();
  for (const command of visibleCommands()) {
    if (names.has(command.name)) {
      throw new Error(`duplicate command: ${command.name}`);
    }
    names.add(command.name);
    if (command.usage.length === 0) {
      throw new Error(`${command.name} has no usage line`);
    }
    if (command.summary.length === 0) {
      throw new Error(`${command.name} has no summary`);
    }
    for (const group of command.groups) {
      if (group.flags.length === 0) {
        throw new Error(`${command.name} has an empty flag group ${group.title}`);
      }
      for (const flag of group.flags) {
        if (flag.name.includes("=") || flag.name.startsWith("-")) {
          throw new Error(`${command.name} --${flag.name} is malformed`);
        }
      }
    }
  }
});

test("registry: the global help lists commands and points at per-command help", () => {
  const help = renderGlobalHelp();
  for (const command of visibleCommands()) {
    if (!help.includes(command.name)) {
      throw new Error(`${command.name} is missing from the global help`);
    }
  }
  if (!help.includes("Run co-maintainer help <command> for details.")) {
    throw new Error("the pointer to per-command help is missing");
  }
  // `remake` is hidden for now, so it must not be advertised.
  if (/^\s+remake\s/m.test(help)) {
    throw new Error("a hidden command was listed");
  }
});

test("registry: the init help groups flags the way the plan asks", () => {
  const help = renderCommandHelp("init");
  if (!help) throw new Error("init has no help");
  for (const title of [
    "Sources",
    "Limits",
    "Pull request filter",
    "AI",
    "GitHub access",
    "Output and diagnostics",
    "Performance",
  ]) {
    if (!help.includes(`${title}:`)) {
      throw new Error(`init help is missing the ${title} group`);
    }
  }
  // Flags the DX research said were undocumented or missing.
  for (const flag of ["--pr-state", "--only-request-changed-pr", "--include-codebase"]) {
    if (!help.includes(flag)) throw new Error(`init help omits ${flag}`);
  }
});

test("registry: the markdown export covers every visible command", () => {
  const markdown = registryToMarkdown();
  for (const command of visibleCommands()) {
    if (!markdown.includes(`## \`co-maintainer ${command.name}\``)) {
      throw new Error(`${command.name} is missing from the markdown export`);
    }
  }
});

test("help: `help <command>` prints that command and exits 0", async () => {
  for (const name of ["probe", "init", "review", "set", "serve"]) {
    const result = await capture(["help", name]);
    if (result.exitCode !== 0) {
      throw new Error(`help ${name} exited ${result.exitCode}`);
    }
    if (!result.stdout.includes(`co-maintainer ${name}`)) {
      throw new Error(`help ${name} did not print its own help:\n${result.stdout}`);
    }
  }
});

test("help: `<command> --help` and `<command> -h` both exit 0", async () => {
  for (const name of ["probe", "init", "review", "set", "serve"]) {
    for (const flag of ["--help", "-h"]) {
      const result = await capture([name, flag]);
      if (result.exitCode !== 0) {
        throw new Error(`${name} ${flag} exited ${result.exitCode}: ${result.stderr}`);
      }
      if (!result.stdout.includes(`co-maintainer ${name}`)) {
        throw new Error(`${name} ${flag} printed the wrong help:\n${result.stdout}`);
      }
    }
  }
});

test("help: `serve --help` prints help and never starts a server", async () => {
  const result = await capture(["serve", "--help"]);
  if (result.exitCode !== 0) {
    throw new Error(`exit ${result.exitCode}: ${result.stderr}`);
  }
  // Before CORE-20 this failed with `--port is required`, meaning the help call
  // fell through into the handler.
  if (/--port is required/.test(result.stderr)) {
    throw new Error(`serve --help fell through to the handler:\n${result.stderr}`);
  }
  if (/\[serve\] listening/.test(result.stdout)) {
    throw new Error("serve --help actually started the server");
  }
  if (!result.stdout.includes("--port=N")) {
    throw new Error(`serve help does not document --port:\n${result.stdout}`);
  }
});

test("help: `review -h` exits 0 (it used to exit 1)", async () => {
  const result = await capture(["review", "-h"]);
  if (result.exitCode !== 0) {
    throw new Error(`exit ${result.exitCode}: ${result.stderr}`);
  }
  if (!result.stdout.includes("--remote")) {
    throw new Error(`review help omits --remote:\n${result.stdout}`);
  }
});

test("help: an unknown command suggests the closest one", async () => {
  const result = await capture(["prob", "owner/repo"]);
  if (result.exitCode !== 2) {
    throw new Error(`exit ${result.exitCode}, wanted 2`);
  }
  if (!result.stderr.includes("Unknown command: prob. Did you mean probe?")) {
    throw new Error(`no suggestion:\n${result.stderr}`);
  }
});

test("version: the `version` command matches `--version`", async () => {
  const command = await capture(["version"]);
  const flag = await capture(["--version"]);
  if (command.stdout.trim() !== VERSION || flag.stdout.trim() !== VERSION) {
    throw new Error(`version ${command.stdout.trim()} / ${flag.stdout.trim()}`);
  }
  if (command.exitCode !== 0 || flag.exitCode !== 0) {
    throw new Error("a version path exited non-zero");
  }
});

test("help: die keeps the suggestion in the message", () => {
  try {
    die(unknownCommandMessage("initt"));
    throw new Error("die returned");
  } catch (error) {
    const message = (error as { message?: string }).message ?? "";
    if (!message.includes("Did you mean init?")) {
      throw new Error(`message: ${message}`);
    }
  }
});
