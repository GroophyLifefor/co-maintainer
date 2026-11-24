import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isolateTestFile } from "../testing/locations.ts";
import { REVIEW_COPY_RULE } from "../pr/review_copy.ts";
import type { AiProvider, AiRequest, Options } from "../types.ts";
import { withCopyRule, withCopyRuleRequest } from "./copy_rule.ts";
import { FakeAiProvider } from "./fake.ts";
import { createAiProvider } from "./provider.ts";

// Every AI call reads the configured timeout. Keep the config in a temp
// home, never the developer's real one.
isolateTestFile();

const request: AiRequest = { job: "test", prompt: "hello", maxTokens: 10 };

/** Provider names `createAiProvider` accepts, each with the key the request
 * would carry. A value is the model the test expects to find in the body. */
const NAMES: Array<[string, Partial<Options>, string]> = [
  ["openrouter", { ai: "openrouter", aiToken: "k" }, "or-model"],
  ["openai", { ai: "openai", aiToken: "k" }, "oa-model"],
  ["anthropic", { ai: "anthropic", aiToken: "k" }, "an-model"],
  ["opencode-zen", { ai: "opencode-zen", aiToken: "k" }, "oz-model"],
  ["opencode-go", { ai: "opencode-go", aiToken: "k" }, "og-model"],
];

/** The text a provider sends over the network for one request. A 400 with an
 * empty body ends the call at once, so nothing retries or waits. */
async function sentBody(provider: AiProvider): Promise<string> {
  const originalFetch = globalThis.fetch;
  let body = "";
  try {
    globalThis.fetch = async (_url, init) => {
      body = String(init?.body ?? "");
      return new Response("{}", { status: 400 });
    };
    await provider.complete(request).catch(() => undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return body;
}

test("a request without a system prompt gets the rule as its system prompt", () => {
  const out = withCopyRuleRequest(request);
  assert.equal(out.system, REVIEW_COPY_RULE);
  assert.equal(out.prompt, "hello");
  assert.equal(out.job, "test");
});

test("a request with a system prompt keeps it and adds the rule after it", () => {
  const out = withCopyRuleRequest({ ...request, system: "You are a bot." });
  assert.equal(out.system, `You are a bot.\n\n${REVIEW_COPY_RULE}`);
});

test("the rule is never added twice", () => {
  const once = withCopyRuleRequest({ ...request, system: "You are a bot." });
  assert.equal(withCopyRuleRequest(once), once);
});

test("the caller's request is not changed", () => {
  const original = { ...request, system: "You are a bot." };
  withCopyRuleRequest(original);
  assert.equal(original.system, "You are a bot.");
});

test("a wrapped provider passes the rule on and follows supportsTools", async () => {
  const seen: AiRequest[] = [];
  const inner: AiProvider = {
    supportsTools: true,
    complete: async (r) => {
      seen.push(r);
      return {
        text: "",
        tokensIn: 0,
        tokensOut: 0,
        model: "m",
        provider: "openrouter",
      };
    },
  };
  const wrapped = withCopyRule(inner);
  await wrapped.complete(request);
  assert.equal(seen[0]!.system, REVIEW_COPY_RULE);
  assert.equal(wrapped.supportsTools, true);
  inner.supportsTools = false;
  assert.equal(wrapped.supportsTools, false);
});

for (const [name, options, model] of NAMES) {
  test(`${name} sends the rule with every job`, async () => {
    const provider = createAiProvider(options as Options, model);
    assert.ok(provider, `${name} has a provider`);
    const body = await sentBody(provider);
    assert.ok(body.includes(model), `${name} body names its model`);
    assert.ok(body.includes(REVIEW_COPY_RULE), `${name} body carries the rule`);
  });
}

test("the fake provider records the rule too", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "copy-rule-"));
  const before = process.env.CM_FAKE_AI_DIR;
  try {
    process.env.CM_FAKE_AI_DIR = dir;
    await new FakeAiProvider().complete({ ...request, system: "Base." });
    const line = readFileSync(join(dir, "requests.jsonl"), "utf8").trim();
    const recorded = JSON.parse(line) as { system: string };
    assert.equal(recorded.system, `Base.\n\n${REVIEW_COPY_RULE}`);
  } finally {
    if (before === undefined) delete process.env.CM_FAKE_AI_DIR;
    else process.env.CM_FAKE_AI_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The files that may build a real provider. Anywhere else would send a
 * request to a model without the rule. */
const MAY_BUILD = new Set([
  "src/ai/provider.ts",
  "src/ai/oauth/registry.ts",
  "benchmark/core_v2/judge.ts",
  // The openai-compatible check `set` runs: one ping, never a review.
  "src/ai/openai_compatible.ts",
]);

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (name.endsWith(".ts") || name.endsWith(".mjs")) yield path;
  }
}

test("no provider class is built outside the factory, the oauth registry and the judge", () => {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const builds =
    /new (?:OpenRouterProvider|OpenAiProvider|AnthropicProvider|SignInWithChatGptProvider)\(/;
  const offenders: string[] = [];
  for (const top of ["src", "scripts", "benchmark"]) {
    for (const path of sourceFiles(join(root, top))) {
      const rel = relative(root, path).replaceAll("\\", "/");
      if (rel.endsWith(".test.ts") || MAY_BUILD.has(rel)) continue;
      if (builds.test(readFileSync(path, "utf8"))) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the judge and the factory wrap what they build", () => {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const judge = readFileSync(join(root, "benchmark/core_v2/judge.ts"), "utf8");
  assert.ok(/withCopyRule\(new OpenRouterProvider\(/.test(judge));
  const factory = readFileSync(join(root, "src/ai/provider.ts"), "utf8");
  assert.ok(/return withCopyRule\(createRawProvider\(/.test(factory));
});
