/** Exit-code contract tests (CORE-10).
 *
 * Plan README decision 2: 0 success, 1 blocking review findings only, 2 usage
 * and precondition errors, 3 runtime errors. These run the CLI as a real child
 * process through the CORE-03 harness, because the contract is about the
 * process exit code, not an in-process return value.
 */
import { test } from "node:test";
import { createCliHarness } from "../testing/cli_harness.ts";
import {
  CliError,
  die,
  EXIT_FINDINGS,
  EXIT_RUNTIME,
  EXIT_USAGE,
} from "./error.ts";
import { reportCliError } from "./main.ts";

test("error: the contract maps to the documented numbers", () => {
  if (EXIT_FINDINGS !== 1) throw new Error(`findings exit is ${EXIT_FINDINGS}`);
  if (EXIT_USAGE !== 2) throw new Error(`usage exit is ${EXIT_USAGE}`);
  if (EXIT_RUNTIME !== 3) throw new Error(`runtime exit is ${EXIT_RUNTIME}`);
});

test("error: die throws a usage CliError with a code and no hint", () => {
  try {
    die("Unknown command: prob");
    throw new Error("die returned");
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw new Error(`expected a CliError, got ${String(error)}`);
    }
    if (error.exitCode !== EXIT_USAGE) {
      throw new Error(`exitCode ${error.exitCode}`);
    }
    if (error.code !== "usage") throw new Error(`code ${error.code}`);
    if (error.hint !== undefined) throw new Error(`hint ${error.hint}`);
  }
});

test("error: an unclassified throw is a runtime failure", () => {
  const previous = process.exit;
  let code: number | undefined;
  process.exit = ((value?: number) => {
    code = value ?? 0;
    throw new Error("sentinel");
  }) as typeof process.exit;
  const error = console.error;
  const lines: string[] = [];
  console.error = (...parts: unknown[]) => lines.push(parts.join(" "));
  try {
    reportCliError(new Error("fetch failed"));
  } catch {
    // the stand-in exit throws to unwind
  } finally {
    process.exit = previous;
    console.error = error;
  }
  if (code !== EXIT_RUNTIME) throw new Error(`exit ${code}`);
  if (!lines.join("\n").includes("[error] fetch failed")) {
    throw new Error(`output: ${lines.join("\n")}`);
  }
});

test("error: a hint prints on its own line as `Hint: ...`", () => {
  const previous = process.exit;
  let code: number | undefined;
  process.exit = ((value?: number) => {
    code = value ?? 0;
    throw new Error("sentinel");
  }) as typeof process.exit;
  const error = console.error;
  const lines: string[] = [];
  console.error = (...parts: unknown[]) => lines.push(parts.join(" "));
  try {
    reportCliError(
      new CliError(
        "remote_not_configured",
        "Remote review is not configured.",
        "co-maintainer set --remote-host=... --remote-token=...",
      ),
    );
  } catch {
    // unwind
  } finally {
    process.exit = previous;
    console.error = error;
  }
  if (code !== EXIT_USAGE) throw new Error(`exit ${code}`);
  const text = lines.join("\n");
  if (!text.startsWith("[error] Remote review is not configured.")) {
    throw new Error(`message line changed: ${text}`);
  }
  if (
    lines[1] !== "Hint: co-maintainer set --remote-host=... --remote-token=..."
  ) {
    throw new Error(`hint line: ${lines[1]}`);
  }
});

test("error: unknown command exits 2 (was 1 before CORE-10)", async () => {
  const harness = await createCliHarness();
  try {
    const result = await harness.run({ args: ["prob", "fixture/repo"] });
    if (result.code !== EXIT_USAGE) {
      throw new Error(`exit ${result.code}: ${result.stderr}`);
    }
    if (!result.stderr.includes("Unknown command: prob")) {
      throw new Error(`stderr: ${result.stderr}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test("error: unknown option exits 2", async () => {
  const harness = await createCliHarness();
  try {
    const result = await harness.run({
      args: ["review", "fixture/repo", "1", "--jsno"],
    });
    if (result.code !== EXIT_USAGE) {
      throw new Error(`exit ${result.code}: ${result.stderr}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test("error: `review --remote` unconfigured exits 2 with the setup hint", async () => {
  const harness = await createCliHarness();
  try {
    const result = await harness.run({
      args: ["review", "--remote", "--json"],
    });
    if (result.code !== EXIT_USAGE) {
      throw new Error(`exit ${result.code}: ${result.stderr}`);
    }
    const body = JSON.parse(result.stdout.trim()) as {
      ok?: boolean;
      error?: { code?: string; hint?: string };
      exitCode?: number;
    };
    if (body.ok !== false || body.error?.code !== "remote_not_configured") {
      throw new Error(`json: ${result.stdout}`);
    }
    if (body.exitCode !== EXIT_USAGE) {
      throw new Error(`json exitCode: ${body.exitCode}`);
    }
    if (
      body.error.hint !==
      "co-maintainer set --remote-host=... --remote-token=..."
    ) {
      throw new Error(`hint: ${body.error.hint}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test("error: a bad repo shape exits 2", async () => {
  const harness = await createCliHarness();
  try {
    const result = await harness.run({ args: ["probe", "not-a-repo"] });
    if (result.code !== EXIT_USAGE) {
      throw new Error(`exit ${result.code}: ${result.stderr}`);
    }
  } finally {
    await harness.cleanup();
  }
});
