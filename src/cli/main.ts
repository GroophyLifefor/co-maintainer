/** CLI dispatch only. Each branch parses nothing itself beyond `args[0]` and
 * calls straight into a command or a service — see PLAN.md Section 3. */
import { parseArgs } from "./args.ts";
import { runServe } from "./commands/serve.ts";
import { runSet } from "./commands/set.ts";
import { runProbe } from "./commands/probe.ts";
import { runReviewFromCli } from "./commands/review.ts";
import { runInitOrRemake } from "../services/setup.ts";
import { VERSION } from "../version.ts";
import { CliError, EXIT_RUNTIME } from "./error.ts";

export async function run(args: string[]): Promise<void> {
  if (args[0] === "-v" || args[0] === "--version") {
    console.log(VERSION);
    return;
  }
  if (args[0] === "set") {
    await runSet(args.slice(1));
    return;
  }
  if (args[0] === "serve") {
    await runServe(args.slice(1));
    return;
  }
  if (args[0] === "review") {
    await runReviewFromCli(args.slice(1));
    return;
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
  process.exit(cli.exitCode);
}
