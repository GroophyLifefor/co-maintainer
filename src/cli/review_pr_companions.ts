/** The companions of a CLI pull request review (issue 81): the `--with`
 * checkouts, and the companion pull requests the repository's `companions`
 * setting allows, read with the user's own GitHub auth. A repository given
 * both ways is read once, from its checkout. */
import type { GitHubClient, Json, Options } from "../types.ts";
import { readConfig } from "../config.ts";
import { log } from "../util/log.ts";
import {
  type Companion,
  type CompanionJson,
  companionsJson,
  MAX_COMPANIONS,
} from "../review/companions.ts";
import type { CoverageWarning } from "../review/coverage.ts";
import type { CompanionSearch } from "../pr/companion_tools.ts";
import {
  prCompanionSearch,
  prCompanionsJson,
  readableCompanions,
  readPrCompanions,
} from "../pr/companion_prs.ts";
import {
  loadCompanions,
  localCompanionSearch,
  readCompanionVisibility,
} from "./review_with.ts";

export type PrReviewCompanions = {
  /** What the prompt gets, `--with` first. */
  list: Companion[];
  /** The `--json` entries, left out when the review has none. */
  json?: CompanionJson[];
  search?: CompanionSearch;
  warnings: CoverageWarning[];
};

export async function prReviewCompanions(
  client: GitHubClient,
  options: Pick<Options, "repo" | "prNumber">,
  flags: string[] | undefined,
): Promise<PrReviewCompanions> {
  // The checkouts' visibility comes from the user's own GitHub auth, the
  // same as the pull request.
  const local = flags?.length
    ? await readCompanionVisibility(
        await loadCompanions(flags, { repo: options.repo }),
        options.repo,
        client,
      )
    : [];
  const listed = readConfig().repos?.[options.repo]?.companions ?? [];
  const skip = local.map((companion) => companion.repo);
  const remaining = listed.filter(
    (name) => !skip.some((repo) => repo.toLowerCase() === name.toLowerCase()),
  );
  // No setting, no read: the review sends what it always sent.
  const fromPr = remaining.length
    ? await readPrCompanions({
        repo: options.repo,
        pr: await client.request<Json>(
          `repos/${options.repo}/pulls/${options.prNumber}`,
        ),
        listed,
        reviewed: client,
        clientFor: () => Promise.resolve(client),
        skip,
        log: (message) => log("review", message),
      })
    : { companions: [], warnings: [] };
  const readable = readableCompanions(fromPr.companions);
  const room = Math.max(0, MAX_COMPANIONS - local.length);
  if (readable.length > room) {
    log(
      "review",
      `companions: --with gave ${local.length}, so ${readable.length - room} from the pull request are left out`,
    );
  }
  const kept = readable.slice(0, room);
  const list: Companion[] = [...local, ...kept];
  const json = [
    ...companionsJson(local),
    ...prCompanionsJson(
      fromPr.companions.filter(
        (companion) =>
          companion.status === "unreachable" || kept.includes(companion),
      ),
    ),
  ];
  if (json.length === 0) return { list, warnings: fromPr.warnings };
  const localSearch = localCompanionSearch(local);
  const pullSearch = prCompanionSearch(kept, undefined, (message) =>
    log("review", message),
  );
  return {
    list,
    json,
    search: (repo, args) =>
      local.some((companion) => companion.repo === repo)
        ? localSearch(repo, args)
        : pullSearch(repo, args),
    warnings: fromPr.warnings,
  };
}
