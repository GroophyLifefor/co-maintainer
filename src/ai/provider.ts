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

export { providerKeyEnv } from "../config.ts";

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

/** A 400 that names one optional part of the request earns one retry without
 * it: the JSON schema, which the prompt asks for anyway, or "thinking off",
 * which a model that always thinks refuses. Undefined when nothing is left to
 * drop, so the caller reports the error. */
export function withoutRefusedPart(
  request: AiRequest,
  detail: string,
  schemaPattern: RegExp,
): AiRequest | undefined {
  if (request.responseFormat && schemaPattern.test(detail)) {
    const { responseFormat: _dropped, ...rest } = request;
    return rest;
  }
  if (
    request.reasoningEffort === "none" &&
    /reasoning|effort|thinking/i.test(detail)
  ) {
    const { reasoningEffort: _dropped, ...rest } = request;
    return rest;
  }
  return undefined;
}

/** The model stopped at its output limit before writing a word. Thinking counts
 * toward that limit, so a thinking model can spend all of it there. Without
 * this the empty answer read as a normal one and failed later as "not JSON". */
export function outputLimitError(provider: string, model: string): Error {
  return new Error(
    `${provider} model ${model} reached its output limit before writing an answer. Thinking counts toward that limit.`,
  );
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
  const text = String(message?.content ?? "");
  if (
    choice?.finish_reason === "length" &&
    !text.trim() &&
    !toolCalls?.length
  ) {
    throw outputLimitError(provider, model);
  }
  return {
    text,
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
