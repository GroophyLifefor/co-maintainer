/** The `sync` rename tests (CORE-21).
 *
 * The contract has two halves that are easy to break in opposite directions:
 * everything the user reads says `sync`, but the stored values that 0.4.13 and
 * existing databases depend on (`job.type`, `remakeCron`, the `/remake` API
 * route) keep their original spelling. Both halves are asserted here.
 */
import { test } from "node:test";
import { run } from "./main.ts";
import { parseArgs } from "./args.ts";
import { renderGlobalHelp } from "./commands/registry.ts";
import { setCliInteractive } from "./args.ts";

async function parse(args: string[]): Promise<Record<string, unknown>> {
  setCliInteractive(false);
  return (await parseArgs(args)) as unknown as Record<string, unknown>;
}

test("sync: `sync` and `remake` produce the same command", async () => {
  const sync = await parse(["sync", "owner/repo", "--ai=none"]);
  const remake = await parse(["remake", "owner/repo", "--ai=none"]);
  if (sync.command !== "remake") {
    throw new Error(`sync mapped to ${String(sync.command)}, wanted remake`);
  }
  if (JSON.stringify(sync) !== JSON.stringify(remake)) {
    throw new Error(
      `sync and remake diverge:\n${JSON.stringify(sync)}\n${JSON.stringify(remake)}`,
    );
  }
});

test("sync: the global help advertises sync and hides remake", async () => {
  const help = renderGlobalHelp();
  if (!/^\s+sync\s/m.test(help)) {
    throw new Error(`sync is not listed:\n${help}`);
  }
  if (/^\s+remake\s/m.test(help)) {
    throw new Error(`remake is still listed:\n${help}`);
  }
  if (help.includes("remake")) {
    throw new Error(`the global help mentions remake:\n${help}`);
  }
});

test("sync: `sync --help` prints sync's help and exits 0", async () => {
  const stdout: string[] = [];
  const log = console.log;
  const previousExit = process.exit;
  console.log = (...parts: unknown[]) => stdout.push(parts.join(" "));
  process.exit = ((code?: number) => {
    throw new Error(`exit ${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await run(["sync", "--help"]);
  } catch (thrown) {
    if (!/exit 0/.test(String(thrown))) throw thrown;
  } finally {
    console.log = log;
    process.exit = previousExit;
  }
  const text = stdout.join("\n");
  if (!text.includes("co-maintainer sync")) {
    throw new Error(`sync help is wrong:\n${text}`);
  }
  if (text.includes("remake")) {
    throw new Error(`sync help still says remake:\n${text}`);
  }
});

test("sync: element labels never say remake", async () => {
  // A hidden alias may still be resolvable, but the dashboard label a user
  // reads for a remake-typed job must be the new wording.
  const { jobLabel } = await import("../server/pages/activity.ts");
  const label = (type: string): string =>
    jobLabel({ type, repo: "o/r" } as never);
  if (label("remake") !== "Synced knowledge") {
    throw new Error(`job label is ${label("remake")}`);
  }
  if (label("init") !== "Set up repository") {
    throw new Error("the init label changed");
  }
});
