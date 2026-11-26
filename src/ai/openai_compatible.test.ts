import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAiBaseUrl, presetBaseUrl } from "./openai_compatible.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenRouterProvider } from "./openrouter.ts";
import {
  compatibleBody,
  openAiCompatibleHost,
  refusedField,
} from "./openai_compatible.ts";
import { readConfig, writeUserConfig } from "../config.ts";
import { isolateTestFile } from "../testing/locations.ts";

const parsed = (raw: string, allowHttp = false) => {
  const result = parseAiBaseUrl(raw, { allowHttp });
  if (!result.ok) throw new Error(result.problem);
  return result.value;
};

test("a base URL is cleaned of a trailing slash and /chat/completions", () => {
  assert.equal(
    parsed("https://x.openai.azure.com/openai/v1/").endpoint,
    "https://x.openai.azure.com/openai/v1/chat/completions",
  );
  assert.equal(
    parsed("https://x.example/v1/chat/completions").base,
    "https://x.example/v1",
  );
  assert.equal(
    parsed("https://x.example").endpoint,
    "https://x.example/chat/completions",
  );
});

test("user info, a query, a fragment and other schemes are refused", () => {
  for (const raw of [
    "https://user:pw@x.example/v1",
    "https://x.example/v1?key=abc",
    "https://x.example/v1#a",
    "ftp://x.example/v1",
    "not a url",
  ]) {
    assert.equal(parseAiBaseUrl(raw).ok, false, raw);
  }
});

test("http is fine for this machine, needs a flag elsewhere, and is marked", () => {
  for (const raw of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:8000/v1",
    "http://[::1]:8000/v1",
  ]) {
    assert.equal(parsed(raw).plainRemote, false, raw);
  }
  assert.equal(parseAiBaseUrl("http://ollama:11434/v1").ok, false);
  assert.equal(parsed("http://ollama:11434/v1", true).plainRemote, true);
});

test("presets fill the address and check what they put in the host", () => {
  const ok = (preset: string, opts = {}) => {
    const result = presetBaseUrl(preset, opts);
    if (!result.ok) throw new Error(result.problem);
    return result.url;
  };
  assert.equal(
    ok("azure", { resource: "my-res" }),
    "https://my-res.openai.azure.com/openai/v1",
  );
  assert.equal(
    ok("bedrock", { region: "us-east-1" }),
    "https://bedrock-mantle.us-east-1.api.aws/v1",
  );
  assert.equal(
    ok("gemini"),
    "https://generativelanguage.googleapis.com/v1beta/openai",
  );
  assert.equal(ok("ollama"), "http://localhost:11434/v1");
  assert.equal(
    presetBaseUrl("azure", { resource: "evil.example/x" }).ok,
    false,
  );
  assert.equal(presetBaseUrl("azure").ok, false);
  assert.equal(
    presetBaseUrl("bedrock", { region: "us-east-1.evil" }).ok,
    false,
  );
  assert.equal(presetBaseUrl("nope").ok, false);
});

// The provider against a local Chat Completions server.

isolateTestFile();

test("the body sends max_completion_tokens, temperature and reasoning_effort, and drops what was refused", () => {
  const request = {
    prompt: "hi",
    maxTokens: 50,
    job: "t",
    reasoningEffort: "high" as const,
  };
  const full = compatibleBody("m", request, new Set());
  assert.equal(full.max_completion_tokens, 50);
  assert.equal(full.temperature, 0);
  assert.equal(full.reasoning_effort, "high");
  assert.equal("reasoning" in full, false);
  const lean = compatibleBody(
    "m",
    request,
    new Set(["max_completion_tokens", "temperature", "reasoning_effort"]),
  );
  assert.equal(lean.max_tokens, 50);
  assert.equal(
    "max_completion_tokens" in lean ||
      "temperature" in lean ||
      "reasoning_effort" in lean,
    false,
  );
  assert.equal(
    refusedField("Unsupported parameter: 'temperature'", new Set()),
    "temperature",
  );
  assert.equal(
    refusedField(
      "Unsupported parameter: 'temperature'",
      new Set(["temperature"]),
    ),
    undefined,
  );
});

test("each refused field is dropped once, the answer comes back, and the lesson is saved for the model", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      res.setHeader("content-type", "application/json");
      if ("temperature" in body) {
        res.statusCode = 400;
        return res.end(
          JSON.stringify({
            error: { message: "Unsupported parameter: 'temperature'" },
          }),
        );
      }
      if ("max_completion_tokens" in body) {
        res.statusCode = 400;
        return res.end(
          JSON.stringify({
            error: {
              message: "Unrecognized request argument: max_completion_tokens",
            },
          }),
        );
      }
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    await writeUserConfig({ ai: "openai-compatible", aiBaseUrl: base });
    const provider = new OpenRouterProvider(
      "",
      "local-model",
      openAiCompatibleHost("local-model"),
    );
    const answer = await provider.complete({
      prompt: "hi",
      maxTokens: 20,
      job: "t",
    });
    assert.equal(answer.text, "ok");
    assert.equal(bodies.length, 3);
    assert.equal(bodies[2]!.max_tokens, 20);
    // The lesson is saved without anyone waiting for it, so a slow disk needs
    // more than a fixed pause: wait for both refused fields, up to five seconds.
    for (
      let waited = 0;
      (readConfig().aiModelQuirks?.["local-model"]?.drop?.length ?? 0) < 2 &&
      waited < 5000;
      waited += 25
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(readConfig().aiModelQuirks?.["local-model"]?.drop, [
      "max_completion_tokens",
      "temperature",
    ]);
    const again = new OpenRouterProvider(
      "",
      "local-model",
      openAiCompatibleHost("local-model"),
    );
    await again.complete({ prompt: "hi", maxTokens: 20, job: "t" });
    assert.equal(
      bodies.length,
      4,
      "the second provider sends the right body at once",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("no base URL, or an unusable one, stops with a message that says how to set it", () => {
  assert.throws(
    () => openAiCompatibleHost("m", {}),
    /--ai-base-url|--ai-preset/,
  );
  assert.throws(
    () => openAiCompatibleHost("m", { aiBaseUrl: "http://ollama:11434/v1" }),
    /http/,
  );
  assert.equal(
    openAiCompatibleHost("m", {
      aiBaseUrl: "http://ollama:11434/v1",
      aiAllowHttp: true,
    }).sendKey,
    false,
  );
});
