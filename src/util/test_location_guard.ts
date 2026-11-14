/** Keeps tests off the developer's real config, cache and database.
 *
 * Node's test runner runs each test file in its own process, at the same time.
 * Two files that open the real cache.db lock each other out on Windows, and
 * two suites run at once overwrite each other's rows. A test reaches the real
 * locations by forgetting one environment variable, often one that only
 * matters on another platform, so this check runs where the product resolves
 * the config and cache directories, and fails the test that got there.
 *
 * It is on only in a process `node --test` started, or a child of one, which
 * Node marks with NODE_TEST_CONTEXT, and only when the code runs from the
 * TypeScript sources. The published package is compiled `.js`, so the check
 * never runs for a user, even inside the user's own test suite. */
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { getEnv, isWindows, type Platform } from "./runtime.ts";

const active =
  getEnv("NODE_TEST_CONTEXT") !== undefined && import.meta.url.endsWith(".ts");

const PLATFORMS: Platform[] = ["linux", "windows", "darwin"];

function insideTemp(path: string): boolean {
  const fold = (value: string) => (isWindows() ? value.toLowerCase() : value);
  // A Windows-style path resolved on Linux keeps its backslashes as part of
  // one name, which still sits under the temp directory when its home does.
  const temp = fold(resolve(tmpdir()));
  const target = fold(resolve(path));
  return target === temp || target.startsWith(`${temp}${sep}`);
}

/** Throws when `dirFor` gives a directory outside the temp directory on any
 * platform. Checking all three from one machine catches the test that moved
 * only `XDG_CACHE_HOME`, which is isolated on Linux and shares the real
 * `LOCALAPPDATA` on Windows. */
export function guardTestLocation(
  kind: "config" | "cache",
  dirFor: (os: Platform) => string,
): void {
  if (!active) return;
  for (const os of PLATFORMS) {
    let dir: string;
    try {
      dir = dirFor(os);
    } catch {
      // No home directory at all. The real lookup reports that itself.
      continue;
    }
    if (!insideTemp(dir)) {
      throw new Error(
        `A test reached the real ${kind} directory ${dir} (resolved as on ${os}). Call isolateTestFile() from src/testing/locations.ts at the top of the test file, or move HOME, USERPROFILE, XDG_CONFIG_HOME, XDG_CACHE_HOME, APPDATA and LOCALAPPDATA into a temp directory.`,
      );
    }
  }
}
