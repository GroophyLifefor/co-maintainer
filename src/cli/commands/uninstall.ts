/** `co-maintainer uninstall`: delete every data file this machine holds.
 *
 * The npm package cannot remove itself while the CLI runs from it, so the
 * command deletes the config, databases, guides, clones, worktrees and tools
 * and then prints the npm command that finishes the job. */
import { CliError, EXIT_USAGE } from "../error.ts";
import { askConfirm } from "../prompt.ts";
import { canPrompt } from "../../tools/codegraph.ts";
import { liveLockPid } from "../../store/app_db.ts";
import { unknownOptionMessage } from "./registry.ts";
import { uninstallData } from "../../services/clear.ts";

export async function runUninstall(args: string[]): Promise<void> {
  for (const arg of args) {
    if (arg !== "--yes") {
      throw new CliError("usage", unknownOptionMessage(arg, "uninstall"));
    }
  }

  const pid = await liveLockPid();
  if (pid !== undefined) {
    throw new CliError(
      "serve_already_running",
      `A co-maintainer serve process (pid ${pid}) is using this data directory.`,
      "Stop it, then run uninstall again.",
      EXIT_USAGE,
    );
  }

  if (!args.includes("--yes")) {
    if (!canPrompt()) {
      throw new CliError(
        "confirmation_required",
        "Uninstall needs your confirmation.",
        "Run it in a terminal, or pass --yes.",
        EXIT_USAGE,
      );
    }
    console.log(
      "This deletes every co-maintainer data file: config.json, the databases, guides, clones, worktrees and tools.",
    );
    if (!(await askConfirm("Uninstall?"))) {
      console.log("Nothing changed.");
      return;
    }
  }

  const removed = await uninstallData();
  if (removed.paths.length === 0) {
    console.log("Nothing to remove.");
  } else {
    console.log("Removed:");
    for (const path of removed.paths) console.log(`  ${path}`);
  }
  console.log("The CLI itself is still installed. Remove it with:");
  console.log("  npm uninstall -g co-maintainer");
}
