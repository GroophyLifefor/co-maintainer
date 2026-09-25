/** `config` command and pre-save verification tests (CORE-22).
 *
 * Two layers: pure helpers (masking, key resolution, row building) run in
 * process, and the verification path runs `runSet` directly so a fake server's
 * socket is the one the check dials. */
import { test } from "node:test";
import {
  configRows,
  flagName,
  maskSecret,
  resolveField,
  runConfig,
} from "./commands/config.ts";
import { runSet } from "./commands/set.ts";
import type { UserConfig } from "../config.ts";
import { createCliHarness } from "../testing/cli_harness.ts";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  readTextFile,
  remove,
  setEnv,
  writeTextFile,
} from "../util/runtime.ts";

test("config: a long secret keeps its last four characters, a short one is fully hidden", () => {
  if (maskSecret("sk-or-v1-abcdef123456") !== "••••3456") {
    throw new Error(`long mask: ${maskSecret("sk-or-v1-abcdef123456")}`);
  }
  if (maskSecret("short") !== "••••") {
    throw new Error(`short mask: ${maskSecret("short")}`);
  }
  // Twelve is the boundary the plan names: at and above it, the tail shows.
  if (maskSecret("twelvechars!") !== "••••ars!") {
    throw new Error(`boundary mask: ${maskSecret("twelvechars!")}`);
  }
  if (maskSecret("elevenchars") !== "••••") {
    throw new Error(`below boundary: ${maskSecret("elevenchars")}`);
  }
});

test("config: flagName and configKey round-trip a field name", () => {
  for (const field of [
    "lowModel",
    "highModel",
    "remoteHost",
    "reviewBlocking",
  ]) {
    const flag = flagName(field);
    const back = flag.replace(/-([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    if (back !== field) throw new Error(`${field} -> ${flag} -> ${back}`);
  }
});

test("config: a kebab-case and a camelCase name resolve to the same field", () => {
  if (resolveField("high-model") !== "highModel") {
    throw new Error("high-model did not resolve");
  }
  if (resolveField("highModel") !== "highModel") {
    throw new Error("highModel did not resolve");
  }
  let threw = false;
  try {
    resolveField("high-models");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("an unknown key was accepted");
});

test("config: rows mark env values as env and never print a secret in full", () => {
  const previous = getEnv("CO_MAINTAINER_TOKEN");
  setEnv("CO_MAINTAINER_TOKEN", "sk-or-v1-abcdef123456");
  try {
    const config: UserConfig = { token: "from-file", highModel: "high/model" };
    const rows = configRows(config);
    const token = rows.find((row) => row.key === "token");
    if (!token) throw new Error("token row missing");
    if (token.source !== "env")
      throw new Error(`token source: ${token.source}`);
    if (token.value.includes("abcdef")) {
      throw new Error(`token leaked: ${token.value}`);
    }
    const model = rows.find((row) => row.key === "high-model");
    if (model?.source !== "file" || model.value !== "high/model") {
      throw new Error(`model row: ${JSON.stringify(model)}`);
    }
  } finally {
    if (previous === undefined) deleteEnv("CO_MAINTAINER_TOKEN");
    else setEnv("CO_MAINTAINER_TOKEN", previous);
  }
});

test("config: the dashboard password reports set, never the hash", () => {
  const rows = configRows({ dashboardPasswordHash: "scrypt$deadbeef" });
  const row = rows.find((item) => item.key === "dashboard-password-hash");
  if (row?.value !== "set") {
    throw new Error(`password row: ${JSON.stringify(row)}`);
  }
  const empty = configRows({});
  if (empty.some((item) => item.key === "dashboard-password-hash")) {
    throw new Error("an unset password was listed");
  }
});

test("config: get prints a single value without a label", async () => {
  const { code, stdout } = await captureConfig(
    () => runConfig(["get", "high-model"]),
    { highModel: "high/model" },
  );
  if (code !== 0) throw new Error(`exit ${code}`);
  if (stdout.trim() !== "high/model") {
    throw new Error(`stdout: ${JSON.stringify(stdout)}`);
  }
});

test("config: get of an unset key is a usage error", async () => {
  const { code } = await captureConfig(
    () => runConfig(["get", "high-model"]),
    {},
  );
  if (code !== 2) throw new Error(`exit ${code} (want 2)`);
});

test("config: get of an unknown key is a usage error", async () => {
  const { code } = await captureConfig(() => runConfig(["get", "nope"]), {});
  if (code !== 2) throw new Error(`exit ${code} (want 2)`);
});

test("config: path prints one line, --all adds repos and cache", async () => {
  const one = await captureConfig(() => runConfig(["path"]), {});
  if (one.stdout.trim().split("\n").length !== 1) {
    throw new Error(`path printed ${JSON.stringify(one.stdout)}`);
  }
  const all = await captureConfig(() => runConfig(["path", "--all"]), {});
  if (all.stdout.trim().split("\n").length !== 3) {
    throw new Error(`path --all printed ${JSON.stringify(all.stdout)}`);
  }
});

test("config: list shows the default source and a written key with its file source", async () => {
  const empty = await captureConfig(() => runConfig(["list"]), {});
  // `review-blocking` has a default of `model`, so a fresh config still lists
  // one row and names the default as where it came from.
  if (!/review-blocking\s+model\s+default/.test(empty.stdout)) {
    throw new Error(`default list: ${JSON.stringify(empty.stdout)}`);
  }
  const one = await captureConfig(() => runConfig(["list"]), {
    highModel: "high/model",
  });
  if (!/high-model\s+high\/model\s+file/.test(one.stdout)) {
    throw new Error(`list: ${JSON.stringify(one.stdout)}`);
  }
});

test("config: get falls back to the default for an unset key", async () => {
  const { code, stdout } = await captureConfig(
    () => runConfig(["get", "review-blocking"]),
    {},
  );
  if (code !== 0) throw new Error(`exit ${code}`);
  if (stdout.trim() !== "model") {
    throw new Error(`stdout: ${JSON.stringify(stdout)}`);
  }
});

test("config set: an unknown model is refused with exit 2 and writes nothing", async () => {
  const server = await startFakeOpenRouter("unknown-model");
  const env = isolate();
  setEnv("CM_OPENROUTER_URL", server.url);
  const dir = await makeTempDir({ prefix: "cm-config-model-" });
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  let code = 0;
  let message = "";
  try {
    try {
      await runSet([
        "--ai=openrouter",
        "--ai-key=sk-key",
        "--high-model=missing/model",
      ]);
    } catch (thrown) {
      code = (thrown as { exitCode?: number }).exitCode ?? 3;
      message = (thrown as Error).message;
    }
    if (code !== 2) throw new Error(`exit ${code} (want 2): ${message}`);
    if (!message.includes("missing/model"))
      throw new Error(`message: ${message}`);
    let wrote = true;
    try {
      await readTextFile(`${dir}/config.json`);
    } catch {
      wrote = false;
    }
    if (wrote) throw new Error("a refused model still wrote config.json");
  } finally {
    env.restore();
    await remove(dir, { recursive: true });
    await server.close();
  }
});

test("config set: a bad key is refused with exit 2 before anything is written", async () => {
  const server = await startFakeOpenRouter("unauthorized");
  const env = isolate();
  setEnv("CM_OPENROUTER_URL", server.url);
  const dir = await makeTempDir({ prefix: "cm-config-key-" });
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  let code = 0;
  try {
    try {
      await runSet([
        "--ai=openrouter",
        "--ai-key=sk-bad",
        "--high-model=high/model",
      ]);
    } catch (thrown) {
      code = (thrown as { exitCode?: number }).exitCode ?? 3;
    }
    if (code !== 2) throw new Error(`exit ${code} (want 2)`);
    let wrote = true;
    try {
      await readTextFile(`${dir}/config.json`);
    } catch {
      wrote = false;
    }
    if (wrote) throw new Error("a rejected key still wrote config.json");
  } finally {
    env.restore();
    await remove(dir, { recursive: true });
    await server.close();
  }
});

test("config set: an unreachable provider warns and saves", async () => {
  const env = isolate();
  // Port 1 accepts nothing, so the check cannot connect: that is the user's
  // network, not their typo, so `set` warns and writes anyway.
  setEnv("CM_OPENROUTER_URL", "http://127.0.0.1:1/api/v1/chat/completions");
  const dir = await makeTempDir({ prefix: "cm-config-net-" });
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = (...parts: unknown[]) => void errors.push(parts.join(" "));
  try {
    await runSet([
      "--ai=openrouter",
      "--ai-key=sk-key",
      "--high-model=high/model",
    ]);
    const written = JSON.parse(await readTextFile(`${dir}/config.json`)) as {
      token?: string;
    };
    if (written.token !== "sk-key") {
      throw new Error(`config not written: ${JSON.stringify(written)}`);
    }
    if (!errors.some((line) => line.includes("could not verify"))) {
      throw new Error(`no warning: ${JSON.stringify(errors)}`);
    }
  } finally {
    console.log = log;
    console.error = error;
    env.restore();
    await remove(dir, { recursive: true });
  }
});

test("config set: --no-verify skips the check entirely and saves", async () => {
  const env = isolate();
  setEnv("CM_OPENROUTER_URL", "http://127.0.0.1:1/api/v1/chat/completions");
  const dir = await makeTempDir({ prefix: "cm-config-nv-" });
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = (...parts: unknown[]) => void errors.push(parts.join(" "));
  try {
    await runSet([
      "--ai=openrouter",
      "--ai-key=sk-key",
      "--high-model=high/model",
      "--no-verify",
    ]);
    const written = JSON.parse(await readTextFile(`${dir}/config.json`)) as {
      highModel?: string;
    };
    if (written.highModel !== "high/model") {
      throw new Error(`config not written: ${JSON.stringify(written)}`);
    }
    if (errors.some((line) => line.includes("could not verify"))) {
      throw new Error(
        `verification ran despite --no-verify: ${JSON.stringify(errors)}`,
      );
    }
  } finally {
    console.log = log;
    console.error = error;
    env.restore();
    await remove(dir, { recursive: true });
  }
});

test("config: the wired CLI answers list, get and path", async () => {
  const harness = await createCliHarness();
  try {
    const path = await harness.run({ args: ["config", "path", "--all"] });
    if (path.code !== 0)
      throw new Error(`path exit ${path.code}: ${path.stderr}`);
    const lines = path.stdout.trim().split("\n");
    if (lines.length !== 3) {
      throw new Error(
        `path --all through main: ${JSON.stringify(path.stdout)}`,
      );
    }
    const empty = await harness.run({ args: ["config", "list"] });
    if (empty.code !== 0 || !empty.stdout.includes("review-blocking")) {
      throw new Error(`list through main: ${JSON.stringify(empty.stdout)}`);
    }
    const help = await harness.run({ args: ["config", "--help"] });
    if (help.code !== 0 || !help.stdout.includes("config get <key>")) {
      throw new Error(`config --help: ${JSON.stringify(help.stdout)}`);
    }
    const unknown = await harness.run({ args: ["config", "nope"] });
    if (unknown.code !== 2) {
      throw new Error(`unknown subcommand exit ${unknown.code}`);
    }
  } finally {
    await harness.cleanup();
  }
});

/** Saves the env names these tests touch, restored by `restore`. */
function isolate(): { restore: () => void } {
  const names = ["CM_CONFIG_PATH", "CM_OPENROUTER_URL"];
  const saved = names.map((name) => [name, getEnv(name)] as const);
  return {
    restore: () => {
      for (const [name, value] of saved) {
        if (value === undefined) deleteEnv(name);
        else setEnv(name, value);
      }
    },
  };
}

/** Runs `fn` with a temp `CM_CONFIG_PATH` holding `config`, capturing stdout
 * and turning a thrown `CliError` into its exit code. */
async function captureConfig(
  fn: () => Promise<void>,
  config: UserConfig,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = isolate();
  const dir = await makeTempDir({ prefix: "cm-config-" });
  const path = `${dir}/config.json`;
  setEnv("CM_CONFIG_PATH", path);
  await writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`);
  const sink: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts: unknown[]) => void sink.push(parts.join(" "));
  console.error = (...parts: unknown[]) => errors.push(parts.join(" "));
  let code = 0;
  try {
    await fn();
  } catch (thrown) {
    code = (thrown as { exitCode?: number }).exitCode ?? 3;
  } finally {
    console.log = log;
    console.error = error;
    env.restore();
    await remove(dir, { recursive: true });
  }
  return { code, stdout: sink.join("\n"), stderr: errors.join("\n") };
}
