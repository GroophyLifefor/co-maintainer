import { HetznerProvider } from "./hetzner.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import type {
  AiMessage,
  AiProvider,
  AiRequest,
  AiResponse,
  Json,
  Options,
} from "../types.ts";

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
  const cost = Number(
    usage?.cost ??
      (usage?.cost_details as Json | undefined)?.total_cost,
  );
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.map((call) => {
      const value = call as Json;
      const fn = value.function as Json | undefined;
      return {
        id: String(value.id ?? ""),
        type: "function" as const,
        function: {
          name: String(fn?.name ?? ""),
          arguments: String(fn?.arguments ?? "{}"),
        },
      };
    }).filter((call) => call.id && call.function.name)
    : undefined;
  return {
    text: String(message?.content ?? ""),
    ...(toolCalls?.length ? { toolCalls } : {}),
    tokensIn: Number(usage?.prompt_tokens ?? 0),
    tokensOut: Number(usage?.completion_tokens ?? 0),
    cost: Number.isFinite(cost) ? cost : undefined,
    model,
    provider,
  };
}

export function chatBody(
  model: string,
  request: AiRequest,
): Json {
  const messages: AiMessage[] = request.messages ?? [
    ...(request.system
      ? [{ role: "system" as const, content: request.system }]
      : []),
    { role: "user" as const, content: request.prompt },
  ];
  return {
    model,
    temperature: 0,
    max_tokens: request.maxTokens,
    ...(request.reasoningEffort
      ? { reasoning: { effort: request.reasoningEffort } }
      : {}),
    messages,
    ...(request.tools?.length
      ? { tools: request.tools, tool_choice: "auto" }
      : {}),
  };
}
