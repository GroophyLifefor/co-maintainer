/** `co-maintainer clear`: delete what `init` produced.
 *
 * A repository goes back to "never inited": guides, the knowledge stamp, the
 * skill state and the settings `init` remembered are gone, so the next build
 * is `init`, not `sync`. `--include-cache` reaches further and takes the
 * fetched evidence too, which makes that next init a cold build.
 *
 * `all` touches every repository on the machine, so it asks first. Pending
 * jobs are asked about separately because they would otherwise rebuild the
 * knowledge after it was cleared. */
import { CliError, EXIT_USAGE } from "../error.ts";
import { askConfirm } from "../prompt.ts";
import { canPrompt } from "../../tools/codegraph.ts";
import { liveLockPid } from "../../store/app_db.ts";
import { unknownOptionMessage } from "./registry.ts";
import {
  cancelOrphanedJobs,
  cancelQueuedJobs,
  clearRepos,
  clearRepo,
  isSafeRepoName,
  listStoredRepos,
  repoJobs,
  withAppDbIfPresent,
} from "../../services/clear.ts";
import type { ClearAllResult, ClearRepoResult } from "../../services/clear.ts";

/** "3 guides, 1 cache row, saved settings" without a trailing separator. */
function joinParts(parts: string[]): string {
  return parts.join(", ");
}

function repoParts(result: ClearRepoResult): string[] {
  const parts: string[] = [];
  if (result.guides > 0) parts.push(`${result.guides} guide file(s)`);
  if (result.cacheRows > 0) parts.push(`${result.cacheRows} cache row(s)`);
  if (result.clones) parts.push("the clone");
  if (result.worktrees) parts.push("the worktrees");
  if (result.settings) parts.push("saved settings");
  return parts;
}

function printRepo(result: ClearRepoResult): void {
  const parts = repoParts(result);
  if (parts.length === 0) {
    console.log(`Nothing to clear for ${result.repo}.`);
    return;
  }
  console.log(`Cleared ${result.repo}: ${joinParts(parts)}.`);
}

function printAll(result: ClearAllResult): void {
  if (result.repos.length === 0) {
    console.log("Nothing to clear.");
    return;
  }
  for (const repo of result.repos) {
    const parts = repoParts(repo);
    if (parts.length > 0) {
      console.log(`Cleared ${repo.repo}: ${joinParts(parts)}.`);
    }
  }
  const extra: string[] = [];
  if (result.cacheFile) extra.push("cache.db");
  if (result.clones) extra.push("every clone");
  if (result.worktrees) extra.push("every worktree");
  if (result.settings) extra.push("saved settings");
  const tail = extra.length > 0 ? ` Also cleared ${joinParts(extra)}.` : "";
  console.log(`Cleared ${result.repos.length} repositories.${tail}`);
}

/** What the pending-job question should say. */
function jobSummary(repos: string[]): string | undefined {
  const jobs = repoJobs(repos);
  const parts: string[] = [];
  if (jobs.queued.length > 0) parts.push(`${jobs.queued.length} queued`);
  if (jobs.running.length > 0) parts.push(`${jobs.running.length} unfinished`);
  if (parts.length === 0) return undefined;
  return `This target has ${joinParts(parts)} job(s).`;
}

/** Pending jobs would rebuild the knowledge this command is deleting. The
 * question is asked once for the whole target. Without a terminal (or with
 * `--yes`) they are canceled: keeping them would contradict the clear. */
async function handlePendingJobs(
  repos: string[],
  assumeYes: boolean,
): Promise<void> {
  await withAppDbIfPresent(async () => {
    const summary = jobSummary(repos);
    if (summary === undefined) return;
    const cancelThem = !canPrompt()
      ? true
      : assumeYes || (await askConfirm(`${summary} Cancel them?`));
    if (!cancelThem) {
      console.log(
        "Pending jobs were kept. They can rebuild the knowledge later.",
      );
      return;
    }
    const canceled = cancelQueuedJobs(repos) + cancelOrphanedJobs(repos);
    if (canceled > 0) console.log(`Canceled ${canceled} job(s).`);
  });
}

export async function runClear(args: string[]): Promise<void> {
  let includeCache = false;
  let yes = false;
  const positionals: string[] = [];
  for (const arg of args) {
    if (arg === "--include-cache") {
      includeCache = true;
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliError("usage", unknownOptionMessage(arg, "clear"));
    }
    positionals.push(arg);
  }
  const target = positionals[0];
  if (positionals.length !== 1 || !target) {
    throw new CliError(
      "usage",
      "clear needs one target: owner/repo or all.",
      "Usage: co-maintainer clear <owner/repo|all> [--include-cache] [--yes]",
    );
  }
  const all = target === "all";
  if (!all && !isSafeRepoName(target)) {
    throw new CliError("usage", "Repository must look like owner/repo");
  }

  // A live serve owns guides and caches: clearing underneath it would confuse
  // webhooks and remote clients mid-flight. The same guard rollback uses.
  const pid = await liveLockPid();
  if (pid !== undefined) {
    throw new CliError(
      "serve_already_running",
      `A co-maintainer serve process (pid ${pid}) is using this data directory.`,
      "Stop it, then run clear again.",
      EXIT_USAGE,
    );
  }

  const repos = all ? await listStoredRepos() : [target];
  if (all && !yes) {
    if (!canPrompt()) {
      throw new CliError(
        "confirmation_required",
        "clear all needs your confirmation.",
        "Run it in a terminal, or pass --yes.",
        EXIT_USAGE,
      );
    }
    const scope = includeCache
      ? "guides, settings, cached evidence, clones and worktrees"
      : "guides and saved settings";
    console.log(
      `This deletes the ${scope} of ${repos.length} repositories on this machine.`,
    );
    if (!(await askConfirm("Clear them?"))) {
      console.log("Nothing changed.");
      return;
    }
  }

  await handlePendingJobs(repos, yes);

  // The snapshot the jobs were negotiated against is the one that gets
  // cleared, so the printed count matches what actually went.
  if (all) printAll(await clearRepos(repos, { includeCache }));
  else printRepo(await clearRepo(target, { includeCache }));
  console.log(
    `Run co-maintainer init ${all ? "owner/repo" : target} to build the guides again.`,
  );
}
