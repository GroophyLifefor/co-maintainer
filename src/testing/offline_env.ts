/** Keeps an in-process test off the developer's machine state and off the
 * network. Shared by tests only.
 *
 * The config, cache, clone and home directories move into `dir`, so
 * config.json, cache.db, clones, worktrees and locks land there on Linux
 * (XDG), Windows (APPDATA, LOCALAPPDATA) and macOS (HOME). git may only use `file` URLs, and `https://github.com/` is
 * rewritten to a directory that does not exist, so a clone the product starts
 * fails at once instead of reaching GitHub. `fetch` refuses every request and
 * records its URL in `fetched`, so a test can assert it made none. `restore`
 * puts the environment and `fetch` back. */
import { pathToFileURL } from "node:url";
import { deleteEnv, getEnv, setEnv } from "./runtime.ts";
import { locationEnv } from "./locations.ts";

export type OfflineEnv = { fetched: string[]; restore: () => void };

export function offlineEnv(dir: string): OfflineEnv {
  const values: Record<string, string> = {
    CM_CLONES_DIR: `${dir}/clones`,
    ...locationEnv(dir),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(`${dir}/no-github`).href}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_SSH_COMMAND: "false",
    GIT_TERMINAL_PROMPT: "0",
  };
  const original = Object.fromEntries(
    Object.keys(values).map((name) => [name, getEnv(name)]),
  );
  for (const [name, value] of Object.entries(values)) setEnv(name, value);
  const fetched: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return Promise.reject(new Error("this test may not use the network"));
  }) as typeof fetch;
  return {
    fetched,
    restore: () => {
      globalThis.fetch = previousFetch;
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) deleteEnv(name);
        else setEnv(name, value);
      }
    },
  };
}
