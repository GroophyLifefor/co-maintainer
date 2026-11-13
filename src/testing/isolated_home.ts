/** Shared by tests only. Runs `fn` with config, app.db, the guide directory,
 * cache.db and the config directory all pointed at a fresh temp directory, so
 * a test never reads or writes the developer's real home, and two test files
 * running in parallel never share a row. */
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  remove,
  setEnv,
} from "../util/runtime.ts";

const NAMES = [
  "CM_CONFIG_PATH",
  "CM_APP_DB",
  "CM_REPOS_DIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
] as const;

export async function withIsolatedHome<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await makeTempDir({ prefix: "cm-isolated-" });
  const saved = NAMES.map((name) => [name, getEnv(name)] as const);
  setEnv("CM_CONFIG_PATH", `${root}/config.json`);
  setEnv("CM_APP_DB", `${root}/app.db`);
  setEnv("CM_REPOS_DIR", `${root}/repos`);
  setEnv("XDG_CACHE_HOME", `${root}/cache`);
  setEnv("XDG_CONFIG_HOME", `${root}/config-home`);
  try {
    return await fn(root);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
    await remove(root, { recursive: true }).catch(() => {});
  }
}
