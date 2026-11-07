/** `--json` for `probe`, `init` and `sync` (issue #53).
 *
 * Help listed `--json` for these commands while the parser refused it with
 * "Unknown option: --json. Did you mean --json?". These run the real CLI and
 * assert that stdout is exactly one JSON document and progress stays on
 * stderr. `serve` prints no result, so its help must not list the flag.
 */
import { test } from "node:test";
import { parseArgs, setCliInteractive } from "./args.ts";
import { renderCommandHelp } from "./commands/registry.ts";
import { CliError } from "./error.ts";
import {
  createCliHarness,
  writeHarnessConfig,
} from "../testing/cli_harness.ts";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";

function parseJson(stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`stdout is not one JSON document:\n${stdout}`);
  }
}

for (const command of ["probe", "init", "sync"]) {
  test(`${command} --json parses and turns prompts off`, async () => {
    setCliInteractive(true);
    const options = await parseArgs([
      command,
      "owner/repo",
      "--ai=none",
      "--json",
    ]);
    if (options.json !== true) {
      throw new Error(`json is ${String(options.json)}`);
    }
  });

  test(`${command} help lists --json`, () => {
    if (!renderCommandHelp(command)?.includes("--json")) {
      throw new Error(`${command} help has no --json`);
    }
  });
}

test("probe --run --json is a usage error", async () => {
  setCliInteractive(false);
  try {
    await parseArgs(["probe", "owner/repo", "--ai=none", "--run", "--json"]);
  } catch (error) {
    if (!(error instanceof CliError) || error.exitCode !== 2) throw error;
    if (!error.message.includes("--run cannot be used with --json")) {
      throw error;
    }
    return;
  }
  throw new Error("probe --run --json was accepted");
});

test("serve help does not list --json", () => {
  const help = renderCommandHelp("serve") ?? "";
  if (help.includes("--json")) throw new Error(`serve lists --json:\n${help}`);
  if (!help.includes("--debug"))
    throw new Error(`serve lost --debug:\n${help}`);
});

test("--only-request-changed-pr help names CHANGES_REQUESTED reviews (#48)", () => {
  const help = renderCommandHelp("init") ?? "";
  if (!help.includes("at least one CHANGES_REQUESTED review")) {
    throw new Error(`init help:\n${help}`);
  }
  if (help.includes("changed the requested files")) {
    throw new Error(`init still has the old text:\n${help}`);
  }
});

test("probe --json prints one document and logs on stderr", async () => {
  const harness = await createCliHarness();
  try {
    const result = await harness.run({
      args: ["probe", "fixture/repo", "--json"],
      env: { CM_FAKE_AI: "1" },
    });
    if (result.code !== 0) {
      throw new Error(`probe exited ${result.code}: ${result.stderr}`);
    }
    const json = parseJson(result.stdout);
    const research = json.research as Record<string, unknown>;
    if (
      json.schemaVersion !== 1 ||
      json.ok !== true ||
      json.command !== "probe" ||
      json.repo !== "fixture/repo" ||
      !String(json.recommended).startsWith("co-maintainer init fixture/repo") ||
      research.pullRequests !== 1
    ) {
      throw new Error(`unexpected probe JSON:\n${result.stdout}`);
    }
    if (!result.stderr.includes("[probe]")) {
      throw new Error(`progress did not reach stderr:\n${result.stderr}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test("init --json and sync --json print one document each", async () => {
  const harness = await createCliHarness();
  const server = await startFakeOpenRouter("success", {
    chatContent: (prompt) =>
      prompt.includes("JSON array")
        ? "[]"
        : "## Section\n\n- Follow the repository convention.\n",
  });
  try {
    await writeHarnessConfig(`${harness.home}/config/config.json`, {
      auth: "gh",
      ai: "openrouter",
      token: "fake-key",
      lowModel: "fake/model",
      highModel: "fake/model",
    });
    for (const command of ["init", "sync"]) {
      const result = await harness.run({
        args: [command, "fixture/repo", "--include-codebase", "--json"],
        openrouterUrl: server.url,
        env: { CM_FAKE_AI: undefined, CM_FAKE_REVIEW_FILE: undefined },
      });
      if (result.code !== 0) {
        throw new Error(`${command} exited ${result.code}: ${result.stderr}`);
      }
      const json = parseJson(result.stdout);
      const usage = json.usage as Record<string, unknown>;
      if (
        json.schemaVersion !== 1 ||
        json.ok !== true ||
        json.command !== command ||
        json.repo !== "fixture/repo" ||
        !String(json.skillPath).endsWith("SKILL.md") ||
        typeof usage.tokensIn !== "number" ||
        typeof json.durationMs !== "number"
      ) {
        throw new Error(`unexpected ${command} JSON:\n${result.stdout}`);
      }
      if (!result.stderr.includes("[done]")) {
        throw new Error(`progress did not reach stderr:\n${result.stderr}`);
      }
    }
  } finally {
    await server.close();
    await harness.cleanup();
  }
});
