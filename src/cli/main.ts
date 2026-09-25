/** CLI dispatch only. Each branch parses nothing itself beyond `args[0]` and
 * calls straight into a command or a service — see PLAN.md Section 3. */
import { parseArgs } from "./args.ts";
import { runServe } from "./commands/serve.ts";
import { runRollback } from "./commands/rollback.ts";
import { runSet } from "./commands/set.ts";
import { runConfig } from "./commands/config.ts";
import { runView } from "./commands/view.ts";
import { runProbe } from "./commands/probe.ts";
import { runReviewFromCli } from "./commands/review.ts";
import { runInitOrRemake } from "../services/setup.ts";
import { VERSION } from "../version.ts";
import { CliError, EXIT_RUNTIME, exitWith } from "./error.ts";
import {
  findCommand,
  renderCommandHelp,
  renderGlobalHelp,
  unknownCommandMessage,
} from "./commands/registry.ts";

/** Every command's help is rendered from the registry, so a new flag cannot
 * drift out of it. `help <command>`, `<command> --help` and `<command> -h` all
 * land here and all exit 0 (CORE-20). */
function printHelpFor(name: string): void {
  const help = renderCommandHelp(name);
  console.log(help ?? renderGlobalHelp());
  exitWith(0);
}

/** True when the help was printed and `run` should stop. */
function handleHelp(args: string[]): boolean {
  const first = args[0];
  if (first === "help") {
    const target = args.find((arg) => !arg.startsWith("-") && arg !== "help");
    if (target) printHelpFor(target);
    else {
      console.log(renderGlobalHelp());
      exitWith(0);
    }
    return true;
  }
  if (first === "--help" || first === "-h") {
    console.log(renderGlobalHelp());
    exitWith(0);
    return true;
  }
  // `<command> --help` without a repo: `serve --help` and `set --help` must not
  // reach their handlers, which would start a server or demand a flag (CORE-20).
  if (first && (args.includes("--help") || args.includes("-h"))) {
    const spec = findCommand(first);
    if (spec) {
      printHelpFor(first);
      return true;
    }
  }
  return false;
}

export async function run(args: string[]): Promise<void> {
  if (handleHelp(args)) return;
  if (args[0] === "-v" || args[0] === "--version" || args[0] === "version") {
    console.log(VERSION);
    return;
  }
  if (args[0] === "set") {
    await runSet(args.slice(1));
    return;
  }
  if (args[0] === "config") {
    await runConfig(args.slice(1));
    return;
  }
  if (args[0] === "view") {
    await runView(args.slice(1));
    return;
  }
  if (args[0] === "serve") {
    await runServe(args.slice(1));
    return;
  }
  if (args[0] === "rollback") {
    await runRollback(args.slice(1));
    return;
  }
  if (args[0] === "review") {
    await runReviewFromCli(args.slice(1));
    return;
  }
  // An unknown command is a usage error with a suggestion, and it must resolve
  // through the registry so hidden aliases still work (CORE-20).
  if (args[0] && !args[0].startsWith("-") && !findCommand(args[0])) {
    throw new CliError("usage", unknownCommandMessage(args[0]));
  }
  const options = await parseArgs(args);
  if (options.command === "probe") await runProbe(options);
  else await runInitOrRemake(options);
}

/** The single place a CLI error turns into output and an exit code (CORE-10).
 * The message's first line and the optional `Hint:` line keep the 0.4.13
 * shape. With `--json` the error goes to stdout as `schemaVersion 1` JSON, the
 * same shape local review already used. CORE-11 later replaces the direct
 * `process.exit` with `exitCode` plus handle cleanup, which is why that work is
 * separate. */
export function reportCliError(error: unknown): void {
  const cli =
    error instanceof CliError
      ? error
      : new CliError(
          "runtime",
          error instanceof Error ? error.message : String(error),
          undefined,
          EXIT_RUNTIME,
        );
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        ok: false,
        error: { code: cli.code, message: cli.message, hint: cli.hint },
        exitCode: cli.exitCode,
      }),
    );
  } else {
    console.error(`[error] ${cli.message}`);
    if (cli.hint) console.error(`Hint: ${cli.hint}`);
  }
  exitWith(cli.exitCode);
}
