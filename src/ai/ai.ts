import { HetznerProvider } from "./hetzner.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import type { AiProvider, AiResponse, Json, Options } from "../types.ts";

export function createAiProvider(
  options: Options,
  model: string,
): AiProvider | undefined {
  if (options.ai === "none") return undefined;
  if (options.ai === "openrouter") {
    return new OpenRouterProvider(
      options.aiToken ?? "",
      model,
    );
  }
  return new HetznerProvider(
    options.aiToken ?? "",
    model,
  );
}

export function parseChatResponse(
  json: Json,
  provider: AiResponse["provider"],
  model: string,
): AiResponse {
  const choice = Array.isArray(json.choices)
    ? json.choices[0] as Json | undefined
    : undefined;
  const message = choice?.message as Json | undefined;
  const usage = json.usage as Json | undefined;
  return {
    text: String(message?.content ?? ""),
    tokensIn: Number(usage?.prompt_tokens ?? 0),
    tokensOut: Number(usage?.completion_tokens ?? 0),
    model,
    provider,
  };
}

export function chatBody(
  model: string,
  request: {
    system?: string;
    prompt: string;
    maxTokens: number;
    reasoningEffort?: "high";
  },
): Json {
  return {
    model,
    temperature: 0,
    max_tokens: request.maxTokens,
    ...(request.reasoningEffort
      ? { reasoning: { effort: request.reasoningEffort } }
      : {}),
    messages: [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      { role: "user", content: request.prompt },
    ],
  };
}
