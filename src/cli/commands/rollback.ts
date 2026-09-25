/** `co-maintainer rollback`: put back the backup an upgrade took (CORE-102b).
 *
 * Only the previous version, and only while the version that made the backup
 * is the one running, because that is the code that knows both the old and the
 * new structure. Data written since the upgrade is lost, so it asks first. */
import { CliError, EXIT_USAGE } from "../error.ts";
import { askConfirm } from "../prompt.ts";
import { unknownOptionMessage } from "./registry.ts";
import { canPrompt } from "../../tools/codegraph.ts";
import { VERSION } from "../../version.ts";
import { backupPaths, liveLockPid } from "../../store/app_db.ts";
import {
  checkRollback,
  restoreBackup,
  rolledBackDir,
} from "../../store/backup.ts";

export async function runRollback(args: string[]): Promise<void> {
  for (const arg of args) {
    if (arg !== "--yes") {
      throw new CliError("usage", unknownOptionMessage(arg, "rollback"));
    }
  }
  const paths = backupPaths();
  const manifest = await checkRollback(paths, VERSION);
  const pid = await liveLockPid();
  if (pid !== undefined) {
    throw new CliError(
      "serve_already_running",
      `A co-maintainer serve process (pid ${pid}) is using this data directory.`,
      "Stop it, then run rollback again.",
      EXIT_USAGE,
    );
  }

  console.log(
    `Rolling back to the backup taken on ${manifest.createdAt}, before the upgrade to ${manifest.toVersion}.`,
  );
  console.log(
    "Everything written since then is lost: reviews, settings and cache.",
  );
  console.log(`The current files are kept in ${rolledBackDir(paths)}.`);
  if (!args.includes("--yes")) {
    if (!canPrompt()) {
      throw new CliError(
        "confirmation_required",
        "Rollback needs your confirmation.",
        "Run it in a terminal, or pass --yes.",
        EXIT_USAGE,
      );
    }
    if (!(await askConfirm("Roll back?"))) {
      console.log("Nothing changed.");
      return;
    }
  }

  await restoreBackup(paths);
  console.log("Restored.");
  console.log(
    manifest.fromVersion
      ? `Now install that version: npm i -g co-maintainer@${manifest.fromVersion}`
      : "Now install the version you upgraded from.",
  );
}
