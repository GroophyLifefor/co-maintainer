import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cacheDbPath, getCacheDir, getConfigDir } from "../config.ts";
import { isolateLocations, LOCATION_NAMES } from "../testing/locations.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
} from "../testing/runtime.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Runs `fn` with every location variable unset except `values`, then puts
 * the environment back. */
function withLocations(values: Record<string, string>, fn: () => void): void {
  const names = [...LOCATION_NAMES, "CM_CONFIG_PATH"];
  const saved = names.map((name) => [name, getEnv(name)] as const);
  for (const name of names) deleteEnv(name);
  for (const [name, value] of Object.entries(values)) setEnv(name, value);
  try {
    fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
  }
}

test("a test that resolves the cache in the real home fails, naming the directory", () => {
  withLocations({ HOME: "/home/someone" }, () => {
    assert.throws(() => cacheDbPath(), /real cache directory \/home\/someone/);
    assert.throws(() => getConfigDir(), /real config directory/);
  });
});

test("moving only the Linux cache variable still fails, because Windows would share LOCALAPPDATA", () => {
  const dir = tempDirSync();
  withLocations(
    {
      HOME: dir,
      XDG_CACHE_HOME: `${dir}/cache`,
      LOCALAPPDATA: "/home/someone/AppData/Local",
    },
    () => {
      assert.throws(() => getCacheDir(), /resolved as on windows/);
    },
  );
});

test("a home that is still the real one fails for macOS even when every XDG and Windows variable moved", () => {
  const dir = tempDirSync();
  withLocations(
    {
      HOME: "/home/someone",
      XDG_CONFIG_HOME: `${dir}/config`,
      XDG_CACHE_HOME: `${dir}/cache`,
      APPDATA: `${dir}/appdata`,
      LOCALAPPDATA: `${dir}/localappdata`,
    },
    () => {
      assert.throws(() => getCacheDir(), /resolved as on darwin/);
    },
  );
});

test("a test with every location in a temp directory passes", () => {
  const dir = tempDirSync();
  const restore = isolateLocations(dir);
  try {
    assert.ok(cacheDbPath().startsWith(dir));
    assert.ok(getConfigDir().startsWith(dir));
  } finally {
    restore();
  }
});

test("an explicit platform and environment are never checked, so the path tests keep working", () => {
  const env = (name: string) => ({ HOME: "/home/u" })[name];
  assert.equal(getCacheDir("linux", env), "/home/u/.cache");
});

test("outside a test process the guard is off and the real path comes back", async () => {
  const dir = tempDirSync();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== "NODE_TEST_CONTEXT") env[name] = value;
  }
  for (const name of LOCATION_NAMES) delete env[name];
  env.HOME = "/home/someone";
  // A file URL, not a path: on Windows the loader reads `d:\...` as a scheme.
  const configUrl = pathToFileURL(join(projectRoot, "src/config.ts")).href;
  const script = `import(${JSON.stringify(configUrl)}).then((m) => console.log(m.getCacheDir()))`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: dir, env, encoding: "utf8" },
  );
  await removePath(dir, { recursive: true });
  assert.equal(result.status, 0, result.stderr);
  const expected =
    process.platform === "win32"
      ? "/home/someone\\AppData\\Local"
      : process.platform === "darwin"
        ? "/home/someone/Library/Caches"
        : "/home/someone/.cache";
  assert.equal(result.stdout.trim(), expected);
});
