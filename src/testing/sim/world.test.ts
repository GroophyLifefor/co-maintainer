/** The world owns the environment: a key in the shell never reaches the
 * product inside a flow, and the shell's environment comes back after. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runFlow } from "./flow.ts";
import { PRODUCT_ENV_NAMES, PRODUCT_ENV_PREFIXES } from "./world.ts";

const SRC = join(import.meta.dirname, "..", "..");

function productFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "testing" ? [] : productFiles(path);
    }
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

test("every environment variable the product reads is one the world clears", () => {
  const read = new Set<string>();
  const pattern =
    /(?:getEnv|env|Env)\("([A-Z][A-Z0-9_]+)"|process\.env\.([A-Z][A-Z0-9_]+)|process\.env\["([A-Z][A-Z0-9_]+)"\]|"([A-Z][A-Z0-9_]*_(?:TOKEN|KEY|MODEL))"/g;
  for (const file of productFiles(SRC)) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      read.add((match[1] ?? match[2] ?? match[3] ?? match[4])!);
    }
  }
  assert.ok(read.has("OPENROUTER_API_KEY"), "the grep finds the key reads");
  const uncovered = [...read].filter(
    (name) =>
      !PRODUCT_ENV_NAMES.includes(name) &&
      !PRODUCT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
  assert.deepEqual(uncovered, []);
});

test("a key in the shell never reaches the product inside a flow", async () => {
  const shell = {
    OPENROUTER_API_KEY: "sk-or-shell-key-should-not-leak",
    CO_MAINTAINER_TOKEN: "shell-token-should-not-leak",
    GH_TOKEN: "ghp_shell_should_not_leak",
    GITHUB_STEP_SUMMARY: "/nonexistent/real-summary",
  };
  const before = { ...process.env };
  Object.assign(process.env, shell);
  try {
    const seen: Record<string, unknown> = {};
    const result = await runFlow(
      {
        name: "env-fixture",
        description: "test fixture",
        steps: [
          {
            name: "read",
            async run(sim) {
              await sim.server.start();
              const { readConfig, resolvedAiToken } =
                await import("../../config.ts");
              seen.token = resolvedAiToken(readConfig());
              seen.worldKey = sim.world.secrets.aiKey;
              seen.ci = process.env.CI;
              seen.summary = process.env.GITHUB_STEP_SUMMARY;
              seen.gh = process.env.GH_TOKEN;
            },
          },
        ],
      },
      {
        mode: "fake",
        provider: "openrouter",
        lowModel: "l",
        highModel: "h",
        origin: performance.now(),
      },
      { step() {}, check() {}, score() {} },
    );
    assert.ok(result.passed);
    assert.equal(seen.token, seen.worldKey);
    assert.equal(seen.ci, "1");
    assert.equal(seen.summary, undefined);
    assert.equal(seen.gh, undefined);
    // The shell's environment is back, its keys included.
    for (const [key, value] of Object.entries(shell)) {
      assert.equal(process.env[key], value);
    }
    assert.equal(process.env.HOME, before.HOME);
    assert.equal(process.env.CI, before.CI);
  } finally {
    for (const key of Object.keys(shell)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});
