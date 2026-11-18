/** Companion pull requests in App review (issue 81). The repository's
 * `companions` setting lists the repositories a review may read. Each one is
 * read with the App client of its own installation, and one that cannot be
 * read gets a `companion_unreachable` warning while the review goes on. A
 * repository without the setting reads nothing and reviews as it always
 * did. */
import type { GitHubClient, Json } from "../types.ts";
import { readConfig } from "../config.ts";
import {
  type CompanionRecord,
  companionRecords,
  companionsChanged,
  companionsMetadataLine,
} from "../review/companions.ts";
import type { ReviewCompanions } from "../pr/companion_tools.ts";
import {
  type CompanionClientFor,
  type PrCompanion,
  prCompanionSearch,
  prCompanionsJson,
  readableCompanions,
  readPrCompanions,
} from "../pr/companion_prs.ts";
import type { SubjectRevisionRow } from "../store/rows.ts";
import { parseCompanionRecords } from "../store/subjects.ts";
import type { LogFn } from "./jobs.ts";

export type AppCompanions = {
  /** Every companion, the unreachable ones too. */
  read: PrCompanion[];
  /** What the round state keeps of the companions the review read. */
  records: CompanionRecord[];
  /** The Metadata line, `""` without companions. */
  metadata: string;
  /** What the engine takes, left out when the review read none. */
  extras?: ReviewCompanions;
};

const NONE: AppCompanions = { read: [], records: [], metadata: "" };

export async function appReviewCompanions(input: {
  repo: string;
  pr: Json;
  github: GitHubClient;
  clientFor: CompanionClientFor;
  log: LogFn;
}): Promise<AppCompanions> {
  const listed = readConfig().repos?.[input.repo]?.companions ?? [];
  if (listed.length === 0) return NONE;
  const { companions, warnings } = await readPrCompanions({
    repo: input.repo,
    pr: input.pr,
    listed,
    reviewed: input.github,
    clientFor: input.clientFor,
    log: (message) => input.log("info", message),
  });
  for (const warning of warnings) {
    input.log("warn", `${warning.code}: ${warning.message}`);
  }
  const list = readableCompanions(companions);
  return {
    read: companions,
    records: companionRecords(list),
    metadata: companionsMetadataLine(prCompanionsJson(companions)),
    ...(list.length
      ? {
          extras: {
            list,
            search: prCompanionSearch(list, undefined, (message) =>
              input.log("info", message),
            ),
          },
        }
      : {}),
  };
}

/** True when the companions differ from the ones the last round recorded. A
 * first round has nothing to differ from. */
export function companionsChangedSince(
  previous: SubjectRevisionRow | undefined,
  records: CompanionRecord[],
): boolean {
  if (!previous) return false;
  return companionsChanged(parseCompanionRecords(previous), records);
}
