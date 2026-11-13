/** `--agent-instructions` and `--agent-instructions-max-chars` on `init` and
 * `sync`: parsed, checked, and taken from the saved repository config when a
 * later run leaves them out. */
import { test } from "node:test";
import { parseArgs, setCliInteractive } from "./args.ts";
import { renderCommandHelp } from "./commands/registry.ts";
import { writeRepoConfig, writeUserConfig } from "../config.ts";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  remove,
  setEnv,
} from "../util/runtime.ts";

async function withConfig(fn: () => Promise<void>): Promise<void> {
  const root = await makeTempDir({ prefix: "cm-agent-args-" });
  const previous = getEnv("CM_CONFIG_PATH");
  setEnv("CM_CONFIG_PATH", `${root}/config.json`);
  setCliInteractive(false);
  try {
    await writeUserConfig({
      ai: "openrouter",
      token: "fake",
      lowModel: "low/model",
      highModel: "high/model",
    });
    await fn();
  } finally {
    if (previous === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", previous);
    await remove(root, { recursive: true });
  }
}

async function exitCode(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 0;
  } catch (thrown) {
    return (thrown as { exitCode?: number }).exitCode ?? 3;
  }
}

test("both flags parse on init and sync, and a blank pattern is kept as off", async () => {
  await withConfig(async () => {
    const init = await parseArgs([
      "init",
      "owner/repo",
      "--agent-instructions=(^|/)(AGENTS|CLAUDE)\\.md$",
      "--agent-instructions-max-chars=-1",
    ]);
    if (
      init.agentInstructions !== "(^|/)(AGENTS|CLAUDE)\\.md$" ||
      init.agentInstructionsMaxChars !== -1
    ) {
      throw new Error(`init: ${JSON.stringify(init)}`);
    }
    const sync = await parseArgs([
      "sync",
      "owner/repo",
      "--agent-instructions=",
    ]);
    if (sync.agentInstructions !== "") {
      throw new Error(
        `a blank pattern was not kept: ${sync.agentInstructions}`,
      );
    }
  });
});

test("a pattern that does not compile, or a cap that is not an integer, exits 2", async () => {
  await withConfig(async () => {
    const regex = await exitCode(() =>
      parseArgs(["init", "owner/repo", "--agent-instructions=(unclosed"]),
    );
    if (regex !== 2) throw new Error(`bad regex exit ${regex}`);
    const cap = await exitCode(() =>
      parseArgs(["sync", "owner/repo", "--agent-instructions-max-chars=lots"]),
    );
    if (cap !== 2) throw new Error(`bad cap exit ${cap}`);
  });
});

test("a later sync with no flags takes the saved values", async () => {
  await withConfig(async () => {
    await writeRepoConfig("owner/repo", {
      agentInstructions: "",
      agentInstructionsMaxChars: 8000,
    });
    const sync = await parseArgs(["sync", "owner/repo"]);
    if (
      sync.agentInstructions !== "" ||
      sync.agentInstructionsMaxChars !== 8000
    ) {
      throw new Error(`saved values lost: ${JSON.stringify(sync)}`);
    }
    const override = await parseArgs([
      "sync",
      "owner/repo",
      "--agent-instructions-max-chars=0",
    ]);
    if (override.agentInstructionsMaxChars !== 0) {
      throw new Error("the flag did not win over the saved value");
    }
  });
});

test("init and sync help list both flags", () => {
  for (const command of ["init", "sync"]) {
    const help = renderCommandHelp(command) ?? "";
    for (const flag of [
      "--agent-instructions=REGEX",
      "--agent-instructions-max-chars=N",
    ]) {
      if (!help.includes(flag)) {
        throw new Error(`${command} help omits ${flag}`);
      }
    }
  }
  const view = renderCommandHelp("view") ?? "";
  if (!view.includes("--sources")) throw new Error("view help omits --sources");
});
