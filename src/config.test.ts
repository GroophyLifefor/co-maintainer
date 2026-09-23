import {
  appPrivateKeyFileMissing,
  getCacheDir,
  getConfigDir,
  loadEnvFile,
  resolveAppPrivateKey,
} from "./config.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "./testing/runtime.ts";
import { test } from "node:test";

/** A fake env lookup so OS branches are tested without touching the real
 * process environment. */
function envOf(values: Record<string, string | undefined>) {
  return (name: string) => values[name];
}

test("getConfigDir: windows uses APPDATA, darwin Library, linux XDG", () => {
  const env = envOf({
    HOME: "/home/u",
    APPDATA: "C:\\Users\\u\\AppData\\Roaming",
    XDG_CONFIG_HOME: "/etc/xdg",
  });
  if (getConfigDir("windows", env) !== "C:\\Users\\u\\AppData\\Roaming") {
    throw new Error("windows APPDATA branch");
  }
  if (getConfigDir("darwin", env) !== "/home/u/Library/Application Support") {
    throw new Error("darwin branch");
  }
  if (getConfigDir("linux", env) !== "/etc/xdg") {
    throw new Error("linux XDG_CONFIG_HOME branch");
  }
});

test("getConfigDir: windows falls back when APPDATA is unset", () => {
  const env = envOf({ USERPROFILE: "C:\\Users\\u" });
  const dir = getConfigDir("windows", env);
  if (dir !== "C:\\Users\\u\\AppData\\Roaming") {
    throw new Error(`windows fallback: ${dir}`);
  }
});

test("getConfigDir: linux falls back to ~/.config without XDG_CONFIG_HOME", () => {
  const env = envOf({ HOME: "/home/u" });
  if (getConfigDir("linux", env) !== "/home/u/.config") {
    throw new Error("linux fallback");
  }
});

test("getCacheDir: windows uses LOCALAPPDATA, darwin Library/Caches, linux XDG", () => {
  const env = envOf({
    HOME: "/home/u",
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    XDG_CACHE_HOME: "/var/cache",
  });
  if (getCacheDir("windows", env) !== "C:\\Users\\u\\AppData\\Local") {
    throw new Error("windows LOCALAPPDATA branch");
  }
  if (getCacheDir("darwin", env) !== "/home/u/Library/Caches") {
    throw new Error("darwin cache branch");
  }
  if (getCacheDir("linux", env) !== "/var/cache") {
    throw new Error("linux XDG_CACHE_HOME branch");
  }
});

test("getCacheDir: linux falls back to ~/.cache", () => {
  const env = envOf({ HOME: "/home/u" });
  if (getCacheDir("linux", env) !== "/home/u/.cache") {
    throw new Error("linux cache fallback");
  }
});

test("getConfigDir/getCacheDir throw when no home variable exists", () => {
  const env = envOf({});
  for (const fn of [
    () => getConfigDir("linux", env),
    () => getCacheDir("linux", env),
  ]) {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    if (!threw)
      throw new Error("expected a throw for a missing home directory");
  }
});

test("loadEnvFile parses KEY=value and export, and never overrides", async () => {
  const dir = tempDirSync();
  const path = `${dir}/.env`;
  await writeTextFile(
    path,
    [
      "# comment",
      "CM_TEST_LOAD_A=from-file",
      "export CM_TEST_LOAD_D=from-file",
      "",
    ].join("\n"),
  );
  const a = getEnv("CM_TEST_LOAD_A");
  const d = getEnv("CM_TEST_LOAD_D");
  deleteEnv("CM_TEST_LOAD_A");
  deleteEnv("CM_TEST_LOAD_D");
  try {
    loadEnvFile(path);
    if (getEnv("CM_TEST_LOAD_A") !== "from-file") {
      throw new Error("KEY=value not loaded");
    }
    if (getEnv("CM_TEST_LOAD_D") !== "from-file") {
      throw new Error("export KEY=value not loaded");
    }
    setEnv("CM_TEST_LOAD_A", "already-set");
    loadEnvFile(path);
    if (getEnv("CM_TEST_LOAD_A") !== "already-set") {
      throw new Error("loadEnvFile overwrote an existing variable");
    }
  } finally {
    deleteEnv("CM_TEST_LOAD_A");
    deleteEnv("CM_TEST_LOAD_D");
    if (a !== undefined) setEnv("CM_TEST_LOAD_A", a);
    if (d !== undefined) setEnv("CM_TEST_LOAD_D", d);
    await removePath(dir, { recursive: true });
  }
});

test("loadEnvFile strips surrounding quotes and ignores blank lines", async () => {
  const dir = tempDirSync();
  const path = `${dir}/.env`;
  await writeTextFile(path, '\nCM_TEST_LOAD_Q="quoted value"\n\n# nope\n');
  const q = getEnv("CM_TEST_LOAD_Q");
  deleteEnv("CM_TEST_LOAD_Q");
  try {
    loadEnvFile(path);
    if (getEnv("CM_TEST_LOAD_Q") !== "quoted value") {
      throw new Error(`quotes not stripped: ${getEnv("CM_TEST_LOAD_Q")}`);
    }
  } finally {
    deleteEnv("CM_TEST_LOAD_Q");
    if (q !== undefined) setEnv("CM_TEST_LOAD_Q", q);
    await removePath(dir, { recursive: true });
  }
});

test("resolveAppPrivateKey reads an inline key, then the path, never both", async () => {
  const dir = tempDirSync();
  const path = `${dir}/app.pem`;
  await writeTextFile(path, "PEM-FROM-FILE\n");
  try {
    // Inline wins when both are somehow present.
    const inline = resolveAppPrivateKey({
      githubAppPrivateKey: "PEM-INLINE",
      githubAppPrivateKeyPath: path,
    });
    if (inline !== "PEM-INLINE") {
      throw new Error(`inline key did not win: ${inline}`);
    }
    // The path is read from disk and is not copied into config.
    const fromPath = resolveAppPrivateKey({
      githubAppPrivateKeyPath: path,
    });
    if (fromPath !== "PEM-FROM-FILE\n") {
      throw new Error(`path was not read: ${fromPath}`);
    }
    // Neither set: unconfigured rather than an error.
    if (resolveAppPrivateKey({}) !== undefined) {
      throw new Error("an empty config produced a key");
    }
    // A path that no longer exists reads as unconfigured.
    if (
      resolveAppPrivateKey({ githubAppPrivateKeyPath: `${dir}/gone.pem` }) !==
      undefined
    ) {
      throw new Error("a missing key file produced a key");
    }
  } finally {
    await removePath(dir, { recursive: true });
  }
});

test("appPrivateKeyFileMissing flags only a configured path with no file", async () => {
  const dir = tempDirSync();
  const path = `${dir}/app.pem`;
  await writeTextFile(path, "PEM\n");
  try {
    if (appPrivateKeyFileMissing({ githubAppPrivateKeyPath: path })) {
      throw new Error("an existing key file was flagged missing");
    }
    if (
      !appPrivateKeyFileMissing({ githubAppPrivateKeyPath: `${dir}/gone.pem` })
    ) {
      throw new Error("a missing key file was not flagged");
    }
    // An inline key needs no file, even beside a stale path.
    if (
      appPrivateKeyFileMissing({
        githubAppPrivateKey: "PEM-INLINE",
        githubAppPrivateKeyPath: `${dir}/gone.pem`,
      })
    ) {
      throw new Error("an inline key was flagged as a missing file");
    }
    // Nothing configured: not a missing file, just unconfigured.
    if (appPrivateKeyFileMissing({})) {
      throw new Error("an empty config was flagged as a missing file");
    }
  } finally {
    await removePath(dir, { recursive: true });
  }
});
