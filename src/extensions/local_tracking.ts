/** Extension findings across local review rounds. They sit in the cache next
 * to the local carry-over, under their own key, so the AI carry-over format
 * does not change. `--fresh` starts them over too. */
import { cacheDelete, cacheGet, cacheSet } from "../store/cache_db.ts";
import type { PreviousExtensionFinding } from "./report.ts";
import type { ExtensionTracking } from "./session.ts";

const NS = "local-extension-findings";

type Stored = { round: number; previous: PreviousExtensionFinding[] };

function key(repo: string, root: string, branch: string): string {
  return `${repo}\0${root}\0${branch}`;
}

export function localTracking(input: {
  repo: string;
  root: string;
  branch: string;
  fresh: boolean;
}): ExtensionTracking {
  const id = key(input.repo, input.root, input.branch);
  let round = 1;
  return {
    async load() {
      if (input.fresh) {
        await cacheDelete(NS, id).catch(() => {});
        return { round, previous: [] };
      }
      const raw = await cacheGet(NS, id);
      if (!raw) return { round, previous: [] };
      const stored = JSON.parse(raw) as Stored;
      round = (stored.round ?? 0) + 1;
      return { round, previous: stored.previous ?? [] };
    },
    async save(_report, previous) {
      await cacheSet(
        NS,
        id,
        JSON.stringify({ round, previous } satisfies Stored),
      );
    },
  };
}
