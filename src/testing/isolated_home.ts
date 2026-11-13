/** Shared by tests only. Runs `fn` with config, app.db, the guide directory,
 * cache.db and the config directory all pointed at a fresh temp directory, so
 * a test never reads or writes the developer's real home, and two test files
 * running in parallel never share a row. The home, config and cache
 * variables move for every platform (see `locations.ts`), not only Linux. */
import { makeTempDir, remove } from "../util/runtime.ts";
import { locationEnv, setEnvFor } from "./locations.ts";

export async function withIsolatedHome<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await makeTempDir({ prefix: "cm-isolated-" });
  const restore = setEnvFor({
    CM_CONFIG_PATH: `${root}/config.json`,
    CM_APP_DB: `${root}/app.db`,
    CM_REPOS_DIR: `${root}/repos`,
    ...locationEnv(root),
  });
  try {
    return await fn(root);
  } finally {
    restore();
    await remove(root, { recursive: true }).catch(() => {});
  }
}
