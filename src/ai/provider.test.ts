import { createAiProvider, rejectRetiredProvider } from "./provider.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import type { AiRequest, Options } from "../types.ts";
import { test } from "node:test";

const request: AiRequest = {
  job: "test",
  prompt: "hello",
  maxTokens: 10,
};

function response(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

test("AI providers parse responses and apply retry policy", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response("openrouter-ok");
    };
    const openrouter = new OpenRouterProvider("test-key", "test-model");
    const openrouterResult = await openrouter.complete(request);
    if (openrouterResult.text !== "openrouter-ok") {
      throw new Error("OpenRouter response was not parsed");
    }
    if (openrouterResult.tokensIn !== 2 || openrouterResult.tokensOut !== 3) {
      throw new Error("OpenRouter usage was not parsed");
    }
    if (calls !== 1) {
      throw new Error("OpenRouter made an unexpected call count");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Hetzner is rejected by name and an unknown provider throws", () => {
  let message = "";
  try {
    rejectRetiredProvider("hetzner");
  } catch (error) {
    message = String((error as Error).message);
  }
  if (!/no longer supported.*openrouter or none/.test(message)) {
    throw new Error(`wrong message: ${message}`);
  }
  rejectRetiredProvider("openrouter");
  let threw = false;
  try {
    createAiProvider({ ai: "hetzner" } as unknown as Options, "m");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("an unknown provider must not fall back");
});
