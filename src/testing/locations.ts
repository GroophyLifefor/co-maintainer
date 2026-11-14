/** Shared by tests only. The environment variables the product resolves the
 * home, config, cache and data directories from, on every platform, in one
 * list, so a helper that moves them cannot forget the one that only matters
 * on Windows or macOS.
 *
 * Linux reads `XDG_CONFIG_HOME` and `XDG_CACHE_HOME`, Windows reads `APPDATA`
 * and `LOCALAPPDATA`, macOS reads `HOME`, and each falls back to the home
 * directory (`HOME`, else `USERPROFILE`). See `getConfigDir` and `getCacheDir`
 * in `src/config.ts`. */
import { after } from "node:test";
import {
  deleteEnv,
  getEnv,
  makeTempDirSync,
  removeSync,
  setEnv,
} from "../util/runtime.ts";

export const LOCATION_NAMES = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

/** Every location variable pointed into `root`. Config and cache land in the
 * same two directories on Linux and Windows, so a test can name a path under
 * `${root}/cache/co-maintainer` on both. */
export function locationEnv(
  root: string,
): Record<(typeof LOCATION_NAMES)[number], string> {
  return {
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: `${root}/config-home`,
    XDG_CACHE_HOME: `${root}/cache`,
    XDG_DATA_HOME: `${root}/data`,
    APPDATA: `${root}/config-home`,
    LOCALAPPDATA: `${root}/cache`,
  };
}

/** Sets `values` in this process and returns a function that puts back what
 * was there before, including unsetting what was unset. */
export function setEnvFor(values: Record<string, string>): () => void {
  const saved = Object.keys(values).map((name) => [name, getEnv(name)]);
  for (const [name, value] of Object.entries(values)) setEnv(name, value);
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) deleteEnv(name!);
      else setEnv(name!, value);
    }
  };
}

/** Moves every location variable into `root` for this process. Returns the
 * function that restores them. */
export function isolateLocations(root: string): () => void {
  return setEnvFor(locationEnv(root));
}

/** Gives the calling test file a temp home of its own for all its tests.
 * Node runs each test file in its own process, so a file that calls this at
 * the top never shares a config, cache.db or app.db with another file. A
 * helper in the file that moves a variable again still works: it puts back
 * this temp value, not the real one. The directory is removed after the
 * file's last test. */
export function isolateTestFile(): string {
  const root = makeTempDirSync({ prefix: "cm-test-home-" });
  const restore = isolateLocations(root);
  after(() => {
    restore();
    try {
      removeSync(root, { recursive: true });
    } catch {
      // Windows keeps a file open a moment after a database closes. The
      // directory is in the temp directory, so leaving it is harmless.
    }
  });
  return root;
}
