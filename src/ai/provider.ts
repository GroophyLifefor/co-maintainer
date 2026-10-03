import { OpenRouterProvider } from "./openrouter.ts";
import { OpenAiProvider } from "./openai.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { openCodeHost } from "./opencode.ts";
import { die } from "../cli/error.ts";
import type {
  AiMessage,
  AiProvider,
  AiRequest,
  AiResponse,
  Json,
  Options,
} from "../types.ts";

/** The one list of accepted `--ai` values, so a new or retired provider is
 * added or removed in a single place instead of the half dozen copies
 * Hetzner's removal had to chase down. */
export const AI_PROVIDERS = [
  "none",
  "openrouter",
  "openai",
  "anthropic",
  "opencode-zen",
  "opencode-go",
] as const;

/** The provider's own key variable. It is read only when that provider runs,
 * so a key meant for one provider is never sent to another. */
export function providerKeyEnv(
  ai: string,
  env: (name: string) => string | undefined,
): string | undefined {
  if (ai === "openrouter") return env("OPENROUTER_API_KEY");
  if (ai === "opencode-zen" || ai === "opencode-go") {
    return env("OPENCODE_API_KEY");
  }
  return undefined;
}

/** Hetzner was dropped in 0.5.1. Naming it beats a generic "must be one of". */
export function rejectRetiredProvider(value: string | undefined): void {
  if (value === "hetzner") {
    die("Hetzner is no longer supported. Use openrouter or none.");
  }
}

export function createAiProvider(
  options: Options,
  model: string,
): AiProvider | undefined {
  if (options.ai === "none") return undefined;
  if (options.ai === "openrouter") {
    return new OpenRouterProvider(options.aiToken ?? "", model);
  }
  if (options.ai === "openai") {
    return new OpenAiProvider(options.aiToken ?? "", model);
  }
  if (options.ai === "anthropic") {
    return new AnthropicProvider(options.aiToken ?? "", model);
  }
  if (options.ai === "opencode-zen" || options.ai === "opencode-go") {
    return new OpenRouterProvider(
      options.aiToken ?? "",
      model,
      openCodeHost(options.ai),
    );
  }
  die(`${options.ai} support is not finished yet. Use openrouter or none.`);
}

export function parseChatResponse(
  json: Json,
  provider: AiResponse["provider"],
  model: string,
): AiResponse {
  const choice = Array.isArray(json.choices)
    ? (json.choices[0] as Json | undefined)
    : undefined;
  const message = choice?.message as Json | undefined;
  const usage = json.usage as Json | undefined;
  const cost = Number(
    usage?.cost ?? (usage?.cost_details as Json | undefined)?.total_cost,
  );
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls
        .map((call) => {
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
        })
        .filter((call) => call.id && call.function.name)
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

export function chatBody(model: string, request: AiRequest): Json {
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
    // A review asks for structured output. The schema is sent even
    // when tools are present, because most providers accept the pair; one that
    // rejects it gets a single retry without the schema (see
    // `OpenRouterProvider.complete`), and the prompt also asks for a fenced
    // JSON block, so a plain-text provider still works.
    ...(request.responseFormat
      ? { response_format: request.responseFormat }
      : {}),
  };
}
