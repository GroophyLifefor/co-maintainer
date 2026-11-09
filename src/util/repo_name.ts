/** One spelling per repository (issue #67).
 *
 * GitHub treats `owner/repo` without regard to case, but co-maintainer keys a
 * repository by its name: the `repos` entry in config.json, the guide folder
 * and the app.db row. Typed two ways, it became two repositories.
 *
 * A name is matched against what is already stored, ignoring case, and the
 * stored spelling wins, so nothing written before changes. A repository seen
 * for the first time is stored in lower case. */
import { readdirSync } from "node:fs";
import { readConfig, reposDir } from "../config.ts";
import { getAppDb, isAppDbOpen } from "../store/app_db.ts";

function storedInDb(lower: string): string | undefined {
  if (!isAppDbOpen()) return undefined;
  try {
    return getAppDb()
      .prepare<{ full_name: string }>(
        `SELECT full_name FROM repos WHERE lower(full_name) = ?
       ORDER BY active DESC, created_at LIMIT 1`,
      )
      .get(lower)?.full_name;
  } catch {
    return undefined;
  }
}

function storedInConfig(lower: string): string | undefined {
  try {
    return Object.keys(readConfig().repos ?? {}).find(
      (name) => name.toLowerCase() === lower,
    );
  } catch {
    return undefined;
  }
}

function caseInsensitiveEntry(dir: string, name: string): string | undefined {
  try {
    return readdirSync(dir).find(
      (entry) => entry.toLowerCase() === name.toLowerCase(),
    );
  } catch {
    return undefined;
  }
}

function storedOnDisk(lower: string): string | undefined {
  const [owner, repo] = lower.split("/") as [string, string];
  const ownerDir = caseInsensitiveEntry(reposDir(), owner);
  if (!ownerDir) return undefined;
  const repoDir = caseInsensitiveEntry(`${reposDir()}/${ownerDir}`, repo);
  return repoDir ? `${ownerDir}/${repoDir}` : undefined;
}

/** The spelling to use for `name` (`owner/repo`). */
export function canonicalRepoName(name: string): string {
  const lower = name.toLowerCase();
  if (!/^[^/]+\/[^/]+$/.test(lower)) return name;
  return (
    storedInDb(lower) ?? storedInConfig(lower) ?? storedOnDisk(lower) ?? lower
  );
}
