/** Every API key provider sends the armed interrupt signal with its request,
 * so Ctrl-C in a local review stops the call in flight. */
import { test } from "node:test";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAiProvider } from "./openai.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import { armInterrupt, disarmInterrupt } from "../util/interrupt.ts";
import type { AiProvider } from "../types.ts";

async function signalSent(provider: AiProvider): Promise<unknown> {
  const original = globalThis.fetch;
  let sent: unknown = "no request";
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    sent = init?.signal;
    return Promise.reject(new Error("stop here"));
  }) as typeof fetch;
  try {
    await provider
      .complete({ job: "test", prompt: "p", maxTokens: 10 })
      .catch(() => {});
  } finally {
    globalThis.fetch = original;
  }
  return sent;
}

const providers: [string, () => AiProvider][] = [
  ["openrouter", () => new OpenRouterProvider("key", "fake/model")],
  ["openai", () => new OpenAiProvider("key", "gpt-fake")],
  ["anthropic", () => new AnthropicProvider("key", "claude-fake")],
];

for (const [name, make] of providers) {
  test(`${name} sends the armed interrupt signal, and none when unarmed`, async () => {
    const controller = armInterrupt();
    try {
      const armed = await signalSent(make());
      if (armed !== controller.signal) {
        throw new Error(`armed: sent ${String(armed)}`);
      }
    } finally {
      disarmInterrupt();
    }
    const unarmed = await signalSent(make());
    if (unarmed !== undefined) {
      throw new Error(`unarmed: sent ${String(unarmed)}`);
    }
  });
}
