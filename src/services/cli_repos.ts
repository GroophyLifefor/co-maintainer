/** Finds repositories a CLI init built before init registered them itself.
 *
 * An older version wrote the guides to disk but never added the repository to
 * app.db, so the dashboard could not see it. `serve` runs this at startup:
 * every `owner/repo` folder with a review guide and no app.db row is added
 * once, as from the CLI. A known repository, including one removed from the
 * dashboard on purpose, is left as it is. */
import { reposDir } from "../config.ts";
import { getRepo, registerCliRepo } from "../store/repos.ts";
import { isNotFound, readDir, stat } from "../util/runtime.ts";

const GUIDE = "PR_REVIEW_GUIDE.md";

async function directories(path: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of readDir(path)) {
      if (entry.isDirectory) names.push(entry.name);
    }
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return names.sort();
}

/** Returns the repositories it added, in name order. */
export async function discoverCliRepos(): Promise<string[]> {
  const root = reposDir();
  const added: string[] = [];
  for (const owner of await directories(root)) {
    for (const name of await directories(`${root}/${owner}`)) {
      const fullName = `${owner}/${name}`;
      if (getRepo(fullName)) continue;
      let builtAt: string;
      try {
        builtAt = (await stat(`${root}/${fullName}/${GUIDE}`)).mtime.toISOString();
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      if (registerCliRepo(fullName, builtAt)) added.push(fullName);
    }
  }
  return added;
}
