import { HetznerProvider } from "./hetzner.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import type { AiRequest } from "../types.ts";

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

Deno.test("AI providers parse responses and apply retry policy", async () => {
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

    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return calls === 1
        ? response("rate-limited", 429)
        : response("hetzner-ok");
    };
    const hetzner = new HetznerProvider(
      "test-key",
      "test-model",
      "https://test.invalid",
      async () => {},
    );
    const hetznerResult = await hetzner.complete(request);
    if (hetznerResult.text !== "hetzner-ok" || calls !== 2) {
      throw new Error("Hetzner did not retry 429 correctly");
    }

    globalThis.fetch = async () => response("unauthorized", 401);
    const fatal = new HetznerProvider(
      "test-key",
      "test-model",
      "https://test.invalid",
      async () => {},
    );
    let failed = false;
    try {
      await fatal.complete(request);
    } catch {
      failed = true;
    }
    if (!failed) throw new Error("Hetzner 401 should be fatal");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
