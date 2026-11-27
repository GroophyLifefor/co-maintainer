/** Finds repositories whose guides are on disk and that app.db does not know.
 *
 * Two ways it happens. An older version wrote the guides to disk from the CLI
 * but never added the repository to app.db. And app.db can be gone while the
 * data folder stays, after a restore of the wrong file or a corrupted
 * database: the guides the server built are still there, and without this the
 * repository would not be listed and its pull requests would be skipped as
 * not active, with nothing to say why. `serve` runs this at startup: every
 * `owner/repo` folder with a review guide and no app.db row is added once, as
 * from the CLI, listed with its guides and with automatic review off, so
 * nothing starts reviewing on its own and nothing is rebuilt. A known
 * repository, including one removed from the dashboard on purpose, is left as
 * it is. */
import { reposDir } from "../config.ts";
import { getRepo, registerCliRepo } from "../store/repos.ts";
import { isNotFound, readDir, stat } from "../util/runtime.ts";

/** What a built set of guides leaves in the repository folder: the CLI's
 * review guide, and the skill file the App's setup writes. */
const GUIDES = ["PR_REVIEW_GUIDE.md", "SKILL.md"];

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
      let builtAt: string | undefined;
      for (const guide of GUIDES) {
        try {
          builtAt = (
            await stat(`${root}/${fullName}/${guide}`)
          ).mtime.toISOString();
          break;
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      if (builtAt === undefined) continue;
      if (registerCliRepo(fullName, builtAt)) added.push(fullName);
    }
  }
  return added;
}
