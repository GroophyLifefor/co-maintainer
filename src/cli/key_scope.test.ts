/** A saved AI key belongs to the saved provider. These parse a real config
 * file and prove a run on any other provider never receives that key, which
 * would send it to the wrong company's servers. */
import { test } from "node:test";
import { parseArgs, setCliInteractive } from "./args.ts";
import { runSet } from "./commands/set.ts";
import { readConfig, savedTokenFor, writeUserConfig } from "../config.ts";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  remove,
  setEnv,
} from "../util/runtime.ts";

const KEY_ENV = [
  "CM_CONFIG_PATH",
  "CO_MAINTAINER_TOKEN",
  "CO_MAINTAINER_AI",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
];

async function withConfig(
  config: Record<string, unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  const dir = await makeTempDir({ prefix: "cm-key-scope-" });
  const saved = KEY_ENV.map((name) => [name, getEnv(name)] as const);
  for (const name of KEY_ENV) deleteEnv(name);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setCliInteractive(false);
  try {
    await writeUserConfig(config);
    await fn();
  } finally {
    setCliInteractive(true);
    for (const [name, value] of saved) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
    await remove(dir, { recursive: true });
  }
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the run to fail");
}

const MODELS = ["--low-model=m/low", "--high-model=m/high"];

test("savedTokenFor: the key goes only to the provider it was saved with", () => {
  const config = { ai: "openrouter", token: "sk-or-saved" } as const;
  if (savedTokenFor(config, "openrouter") !== "sk-or-saved") {
    throw new Error("the saved provider lost its key");
  }
  if (savedTokenFor(config, "anthropic") !== undefined) {
    throw new Error("another provider got the saved key");
  }
  // A config written before the provider was saved holds an OpenRouter key.
  if (savedTokenFor({ token: "sk-or-old" }, "openrouter") !== "sk-or-old") {
    throw new Error("an older config lost its OpenRouter key");
  }
  if (savedTokenFor({ token: "sk-or-old" }, "openai") !== undefined) {
    throw new Error("an older config key reached OpenAI");
  }
  // The dashboard writes ai "none" for an older config, and the key it kept
  // is still the OpenRouter one.
  const off = { ai: "none", token: "sk-or-old" } as const;
  if (savedTokenFor(off, "openrouter") !== "sk-or-old") {
    throw new Error("switching AI off lost the OpenRouter key");
  }
});

test("--ai for another provider does not take the saved key", async () => {
  await withConfig({ ai: "openrouter", token: "sk-or-saved" }, async () => {
    const message = await failure(() =>
      parseArgs(["sync", "o/r", "--ai=anthropic", ...MODELS]),
    );
    if (!message.includes("Missing anthropic API key")) {
      throw new Error(message);
    }
    const own = await parseArgs([
      "sync",
      "o/r",
      "--ai=anthropic",
      "--token=sk-ant-given",
      ...MODELS,
    ]);
    if (own.aiToken !== "sk-ant-given") throw new Error(String(own.aiToken));
  });
});

test("a repo pinned to an older provider does not take the new provider's key", async () => {
  await withConfig(
    {
      ai: "anthropic",
      token: "sk-ant-saved",
      repos: { "o/r": { ai: "openrouter" } },
    },
    async () => {
      const message = await failure(() =>
        parseArgs(["sync", "o/r", ...MODELS]),
      );
      if (!message.includes("Missing openrouter API key")) {
        throw new Error(message);
      }
    },
  );
});

test("set --ai to another provider needs that provider's key", async () => {
  await withConfig({ ai: "openrouter", token: "sk-or-saved" }, async () => {
    const message = await failure(() => runSet(["--ai=anthropic"]));
    if (!message.includes("The saved key is for openrouter")) {
      throw new Error(message);
    }
    const after = readConfig();
    if (after.ai !== "openrouter" || after.token !== "sk-or-saved") {
      throw new Error("a refused switch changed the config");
    }
    await runSet(["--ai=anthropic", "--token=sk-ant-new", "--no-verify"]);
    if (readConfig().ai !== "anthropic") throw new Error("switch not saved");
  });
});
