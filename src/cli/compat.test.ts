/** Backward-compatibility golden tests (CORE-02).
 *
 * Everything here pins the 0.4.13 CLI surface as recorded in
 * `src/testing/fixtures/cli_compat.ts`. Later tasks may add cases. They must
 * not change an existing expectation, except for the exit code change approved
 * as decision 2 in `dx-research/plans/README.md`, which CORE-10 implements and
 * whose cases are marked with `exitCodeDecision`.
 *
 * The parser is pure input to output, so these call it directly rather than
 * spawning a process. Anything that spawns lives in CORE-03's harness.
 */
import { test } from "node:test";
import { parseArgs, setCliInteractive } from "./args.ts";
import { parseReviewArgs } from "./review_args.ts";
import { runSet } from "./commands/set.ts";
import { run } from "./main.ts";
import { VERSION } from "../version.ts";
import { configPath, readConfig } from "../config.ts";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  readTextFile,
  remove,
  setEnv,
  writeTextFile,
} from "../util/runtime.ts";
import {
  HELP_CASES,
  PARSE_CASES,
  PARSE_DEFAULTS,
  REVIEW_MODE_CASES,
  SET_CASES,
} from "../testing/fixtures/cli_compat.ts";

/** Env vars the parser reads, cleared so a developer's own shell cannot turn
 * a golden case green or red. */
const PARSER_ENV = [
  "CO_MAINTAINER_AI",
  "CO_MAINTAINER_AUTH",
  "CO_MAINTAINER_TOKEN",
  "OPENROUTER_API_KEY",
  "HETZNER_API_KEY",
  "OPENROUTER_LOW_MODEL",
  "OPENROUTER_HIGH_MODEL",
  "HETZNER_LOW_MODEL",
  "HETZNER_HIGH_MODEL",
  "LOW_MODEL",
  "HIGH_MODEL",
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

type EnvSnapshot = Record<string, string | undefined>;

function clearParserEnv(): EnvSnapshot {
  const saved: EnvSnapshot = {};
  for (const name of PARSER_ENV) {
    saved[name] = getEnv(name);
    deleteEnv(name);
  }
  return saved;
}

function restoreEnv(saved: EnvSnapshot): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) deleteEnv(name);
    else setEnv(name, value);
  }
}

function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = clearParserEnv();
  return fn().finally(() => restoreEnv(saved));
}

/** Runs `fn` with `CM_CONFIG_PATH` pointing at a nonexistent file inside a
 * fresh temp dir, so `readConfig` returns `{}` and the golden values cannot be
 * rewritten by whatever the developer has in their real config.json. The temp
 * dir is passed in so a case that needs a real file (an env file) can use it. */
async function withIsolatedConfig<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await makeTempDir({ prefix: "cm-compat-" });
  const previous = getEnv("CM_CONFIG_PATH");
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  try {
    return await withEnv(() => fn(dir));
  } finally {
    if (previous === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", previous);
    await remove(dir, { recursive: true });
  }
}

type ConsoleSink = { stdout: string[]; stderr: string[] };

/** Captures `console.log`/`console.error` and turns the historical
 * `process.exit(0)` help path into a returned exit code, so a test can assert
 * on it without tearing the test runner down. */
async function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; exitCode: number | undefined; sink: ConsoleSink }> {
  const sink: ConsoleSink = { stdout: [], stderr: [] };
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  let exitCode: number | undefined;
  console.log = (...args: unknown[]) => {
    sink.stdout.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    sink.stderr.push(args.join(" "));
  };
  // The help paths call `process.exit(0)`. Stand it down to a throw so the
  // stack unwinds cleanly, then swallow that specific sentinel.
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new ExitSentinel(code ?? 0);
  }) as typeof process.exit;
  let value: T;
  try {
    value = await fn();
  } catch (thrown) {
    if (thrown instanceof ExitSentinel) {
      value = undefined as T;
    } else {
      throw thrown;
    }
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
  return { value, exitCode, sink };
}

class ExitSentinel extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

async function parse(
  args: string[],
): Promise<{ options?: Record<string, unknown>; error?: string }> {
  try {
    const options = await parseArgs(args);
    return { options: options as unknown as Record<string, unknown> };
  } catch (thrown) {
    return { error: thrown instanceof Error ? thrown.message : String(thrown) };
  }
}

/** Replaces `${DIR}` in a recorded case with the isolated temp dir. The
 * fixture keeps the placeholder, so the input a case executes is still the
 * input it records, only with the runtime directory substituted. */
function substituteDir(args: string[], dir: string): string[] {
  return args.map((arg) => arg.replaceAll("${DIR}", dir));
}

/** `--env` loads a real file, so a case that uses it needs one that exists. */
async function prepareEnvFile(args: string[]): Promise<void> {
  const flag = args.find((arg) => arg.startsWith("--env="));
  if (!flag) return;
  await writeTextFile(flag.slice("--env=".length), "");
}

for (const testCase of PARSE_CASES) {
  test(`compat/parse: ${testCase.name}`, async () => {
    // The recorded runs are the non-interactive contract: a missing value must
    // either come from a fallback or fail, never block on a prompt.
    setCliInteractive(false);
    await withIsolatedConfig(async (dir) => {
      const args = substituteDir(testCase.args, dir);
      await prepareEnvFile(args);
      const { options, error } = await parse(args);
      if ("error" in testCase.expect) {
        if (error !== testCase.expect.error) {
          throw new Error(
            `expected error ${JSON.stringify(testCase.expect.error)}, got ${JSON.stringify(error ?? options)}`,
          );
        }
        return;
      }
      if (error !== undefined) throw new Error(`unexpected error: ${error}`);
      const expected = { ...PARSE_DEFAULTS, ...testCase.expect };
      for (const [key, rawWant] of Object.entries(expected)) {
        const want =
          typeof rawWant === "string"
            ? rawWant.replaceAll("${DIR}", dir)
            : rawWant;
        const got = options![key];
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          throw new Error(
            `${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
          );
        }
      }
      // A missing key and an explicit `undefined` both mean unset here, so an
      // "unset" case asserts the value rather than the key's presence.
      for (const key of testCase.absent ?? []) {
        if (options![key] !== undefined) {
          throw new Error(
            `${key}: expected to be unset, got ${JSON.stringify(options![key])}`,
          );
        }
      }
    });
  });
}

for (const testCase of REVIEW_MODE_CASES) {
  test(`compat/review: ${testCase.name}`, async () => {
    setCliInteractive(false);
    await withIsolatedConfig(async (dir) => {
      const args = substituteDir(testCase.args, dir);
      let parsed;
      try {
        parsed = await parseReviewArgs(args);
      } catch (thrown) {
        const message =
          thrown instanceof Error ? thrown.message : String(thrown);
        if (message !== testCase.error) {
          throw new Error(
            `expected error ${JSON.stringify(testCase.error)}, got ${JSON.stringify(message)}`,
          );
        }
        return;
      }
      if (testCase.error) {
        throw new Error(`expected error, got mode ${parsed.mode}`);
      }
      if (parsed.mode !== testCase.mode) {
        throw new Error(`expected mode ${testCase.mode}, got ${parsed.mode}`);
      }
      for (const [key, want] of Object.entries(testCase.flags ?? {})) {
        const got = (parsed as unknown as Record<string, unknown>)[key];
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          throw new Error(
            `${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
          );
        }
      }
    });
  });
}

/** Runs a list of `set` invocations against one temp config file, returning
 * the combined stdout, the final file, and whether any invocation failed.
 * Multiple invocations share the file so two-step flows (set then unset) are
 * exercised the way a user would run them. */
async function runSetSteps(steps: string[][]): Promise<{
  stdout: string;
  snapshots: Record<string, unknown>[];
  error?: string;
}> {
  const dir = await makeTempDir({ prefix: "cm-compat-" });
  const path = `${dir}/config.json`;
  const previous = getEnv("CM_CONFIG_PATH");
  setEnv("CM_CONFIG_PATH", path);
  const sink: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => {
    sink.push(parts.join(" "));
  };
  const snapshots: Record<string, unknown>[] = [];
  let error: string | undefined;
  async function snapshot(): Promise<void> {
    try {
      snapshots.push(
        JSON.parse(await readTextFile(path)) as Record<string, unknown>,
      );
    } catch {
      snapshots.push({});
    }
  }
  try {
    for (const step of steps) {
      try {
        await runSet(step);
      } catch (thrown) {
        error =
          error ?? (thrown instanceof Error ? thrown.message : String(thrown));
      }
      await snapshot();
    }
  } finally {
    console.log = log;
    if (previous === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", previous);
  }
  await remove(dir, { recursive: true });
  return { stdout: sink.join("\n"), snapshots, error };
}

/** Checks a config subset, reporting the first field that disagrees. */
function expectConfig(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
): void {
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key];
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(
        `${label} ${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
    }
  }
}

for (const testCase of SET_CASES) {
  test(`compat/set: ${testCase.name}`, async () => {
    await withEnv(async () => {
      const result = await runSetSteps([
        testCase.args,
        ...(testCase.thenArgs ? [testCase.thenArgs] : []),
      ]);
      if (testCase.error) {
        if (!result.error?.includes(testCase.error)) {
          throw new Error(
            `expected error containing ${JSON.stringify(testCase.error)}, got ${JSON.stringify(result.error ?? result.stdout)}`,
          );
        }
        // A rejected invocation must not have written a partial config. The
        // invalid cases declare `config: {}`, and an empty subset check would
        // assert nothing, so "empty" has to be checked as a whole.
        const written = result.snapshots[result.snapshots.length - 1] ?? {};
        const keys = Object.keys(written);
        if (keys.length > 0) {
          throw new Error(
            `rejected set wrote config keys: ${JSON.stringify(keys)}`,
          );
        }
        return;
      }
      if (result.error) throw new Error(`unexpected error: ${result.error}`);
      expectConfig(result.snapshots[0]!, testCase.config, "after set");
      if (testCase.thenConfig) {
        expectConfig(
          result.snapshots[result.snapshots.length - 1]!,
          testCase.thenConfig,
          "after then",
        );
      }
      if (testCase.stdout && result.stdout.trim() !== testCase.stdout) {
        throw new Error(
          `stdout: expected ${JSON.stringify(testCase.stdout)}, got ${JSON.stringify(result.stdout.trim())}`,
        );
      }
      if (testCase.contains && !result.stdout.includes(testCase.contains)) {
        throw new Error(
          `stdout missing ${JSON.stringify(testCase.contains)}: ${JSON.stringify(result.stdout)}`,
        );
      }
    });
  });
}

for (const testCase of HELP_CASES) {
  test(`compat/help: ${testCase.name}`, async () => {
    await withEnv(async () => {
      const isVersion =
        testCase.args[0] === "--version" || testCase.args[0] === "-v";
      const { exitCode, sink } = await captureConsole(() => run(testCase.args));
      const output = sink.stdout.join("\n");
      const expectedExit = testCase.exitCode;
      const gotExit = exitCode ?? 0;
      if (gotExit !== expectedExit) {
        throw new Error(`exit: expected ${expectedExit}, got ${gotExit}`);
      }
      const firstLine = isVersion ? VERSION : testCase.firstLine;
      if (!output.split("\n")[0]?.startsWith(firstLine)) {
        throw new Error(
          `first line: expected ${JSON.stringify(firstLine)}, got ${JSON.stringify(output.split("\n")[0])}`,
        );
      }
      if (!isVersion && !output.includes("serve")) {
        throw new Error("usage output is missing the serve command");
      }
      if (!isVersion && !output.includes("probe")) {
        throw new Error("usage output is missing the probe command");
      }
    });
  });
}

test("compat: configPath honours CM_CONFIG_PATH so the golden runs never touch the real config", async () => {
  const dir = await makeTempDir({ prefix: "cm-compat-" });
  const previous = getEnv("CM_CONFIG_PATH");
  const path = `${dir}/nested/config.json`;
  setEnv("CM_CONFIG_PATH", path);
  try {
    const resolved = configPath();
    if (resolved !== path) {
      throw new Error(`configPath: expected ${path}, got ${resolved}`);
    }
    if (Object.keys(readConfig()).length !== 0) {
      throw new Error("missing config should read as an empty object");
    }
  } finally {
    if (previous === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", previous);
    await remove(dir, { recursive: true });
  }
});
