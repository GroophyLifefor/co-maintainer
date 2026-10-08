import {
  AI_PROVIDERS,
  createAiProvider,
  rejectRetiredProvider,
} from "./provider.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import { OpenAiProvider } from "./openai.ts";
import { AnthropicProvider, parseMessagesBody } from "./anthropic.ts";
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

test("the provider list names every accepted --ai value", () => {
  if (
    AI_PROVIDERS.join(",") !==
    "none,openrouter,openai,anthropic,opencode-zen,opencode-go"
  ) {
    throw new Error(`provider list: ${AI_PROVIDERS.join(",")}`);
  }
});

test("anthropic is created with the given key and model", () => {
  const provider = createAiProvider(
    { ai: "anthropic", aiToken: "sk-ant-test" } as unknown as Options,
    "claude-opus-5",
  );
  if (!(provider instanceof AnthropicProvider)) {
    throw new Error("expected an AnthropicProvider");
  }
});

test("openai is created with the given key and model", () => {
  const provider = createAiProvider(
    { ai: "openai", aiToken: "sk-test" } as unknown as Options,
    "gpt-6-luna",
  );
  if (!(provider instanceof OpenAiProvider)) {
    throw new Error("expected an OpenAiProvider");
  }
});

test("a model that must think gets the request again without thinking off", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Reasoning is mandatory for this endpoint and cannot be disabled.",
            },
          }),
          { status: 400 },
        );
      }
      return response("[]");
    };
    const provider = new OpenRouterProvider("test-key", "test-model");
    const result = await provider.complete({
      ...request,
      reasoningEffort: "none",
    });
    if (result.text !== "[]") throw new Error(result.text);
    if (bodies.length !== 2) throw new Error(`${bodies.length} calls`);
    const [first, second] = bodies;
    if ((first!.reasoning as { effort?: string })?.effort !== "none") {
      throw new Error(`first ${JSON.stringify(first!.reasoning)}`);
    }
    if ("reasoning" in second!) throw new Error("the retry still asked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an answer cut off before its first word says so", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "length", message: { content: "" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1200 },
        }),
        { status: 200 },
      );
    let message = "";
    try {
      await new OpenRouterProvider("test-key", "test-model").complete(request);
    } catch (error) {
      message = (error as Error).message;
    }
    if (!message.includes("reached its output limit")) throw new Error(message);

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "reasoning", summary: [] }],
          usage: { input_tokens: 2, output_tokens: 1200 },
        }),
        { status: 200 },
      );
    message = "";
    try {
      await new OpenAiProvider("test-key", "test-model").complete(request);
    } catch (error) {
      message = (error as Error).message;
    }
    if (!message.includes("reached its output limit")) throw new Error(message);
  } finally {
    globalThis.fetch = originalFetch;
  }
  let message = "";
  try {
    parseMessagesBody(
      {
        stop_reason: "max_tokens",
        content: [{ type: "thinking", thinking: "..." }],
        usage: { input_tokens: 2, output_tokens: 1200 },
      },
      "claude-test",
    );
  } catch (error) {
    message = (error as Error).message;
  }
  if (!message.includes("reached its output limit")) throw new Error(message);
});
