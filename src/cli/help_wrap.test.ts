/** Long options must not run into their description in real `--help` output.
 *
 * The description column starts at 42. An option longer than that used to
 * print as `--ai=...|opencode-goWhich provider ...`; it must now end its line
 * and start the description on the next one, aligned to the column. Asserted
 * through the real CLI process, not the renderer alone. */
import { join } from "node:path";
import { commandOutput } from "../util/runtime.ts";
import { runtimeExecPath, runtimeRunArgs } from "../testing/runtime.ts";
import { test } from "node:test";

const COLUMN = 42;
const ROOT = join(import.meta.dirname, "..", "..");

async function help(command: string): Promise<string[]> {
  const result = await commandOutput(runtimeExecPath(), {
    args: runtimeRunArgs("main.ts", [command, "--help"]),
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  });
  const out = new TextDecoder().decode(result.stdout);
  if (!result.success) throw new Error(`${command} --help failed: ${out}`);
  return out.split("\n");
}

test("a long option ends its line and the description starts on the next", async () => {
  const lines = await help("init");
  const at = lines.indexOf(
    "  --ai=openrouter|openai|anthropic|opencode-zen|opencode-go",
  );
  if (at < 0)
    throw new Error(
      `the long --ai option is not on a line of its own:\n${lines.join("\n")}`,
    );
  const next = lines[at + 1] ?? "";
  if (
    next !==
    `${" ".repeat(COLUMN)}Which provider writes the guides. Required: init and sync cannot run without one.`
  ) {
    throw new Error(
      `the description is not aligned under the column: ${JSON.stringify(next)}`,
    );
  }
});

test("set --review-policy keeps every allowed value and a gap before its text", async () => {
  const lines = await help("set");
  const at = lines.findIndex((line) => line.startsWith("  --review-policy="));
  if (at < 0) throw new Error("no --review-policy line");
  if (lines[at] !== "  --review-policy=everyone|trusted-auto|on-request-only") {
    throw new Error(`the policy values were cut or glued: ${lines[at]}`);
  }
  if (!lines[at + 1]?.startsWith(`${" ".repeat(COLUMN)}The review policy`)) {
    throw new Error(`no aligned description: ${lines[at + 1]}`);
  }
});

test("every option of every visible command is separated from its description", async () => {
  for (const command of [
    "init",
    "sync",
    "review",
    "set",
    "serve",
    "view",
    "config",
  ]) {
    const lines = await help(command);
    for (const [i, line] of lines.entries()) {
      if (!line.startsWith("  --")) continue;
      // Either the option alone on its line (description below, aligned) or
      // option, at least two spaces, then the description at the column.
      const head = line.slice(0, COLUMN);
      const rest = line.slice(COLUMN);
      const alone = !line.slice(2).includes(" ");
      if (alone) {
        const below = lines[i + 1] ?? "";
        if (below.trim() && !below.startsWith(" ".repeat(COLUMN))) {
          throw new Error(
            `${command}: description under ${line.trim()} is not aligned: ${below}`,
          );
        }
        continue;
      }
      if (!/ {2}$/.test(head) && rest.length > 0) {
        throw new Error(
          `${command}: option runs into its description: ${line}`,
        );
      }
      if (line.includes("\u001b["))
        throw new Error(`${command}: ANSI code in help: ${line}`);
    }
  }
});
