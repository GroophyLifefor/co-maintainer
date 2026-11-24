import { OpenRouterProvider } from "./openrouter.ts";
import { OpenAiProvider } from "./openai.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { openCodeHost } from "./opencode.ts";
import { EXPERIMENTAL_OAUTH_PROVIDER, oauthOps } from "./oauth/registry.ts";
import { withSecretMask } from "./mask_secrets.ts";
import { withCopyRule } from "./copy_rule.ts";
import { die } from "../cli/error.ts";
import { OutputLimitError } from "./output_limit.ts";
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

/** The provider a run actually calls. `--experimental-siwc` overrides the
 * configured `ai` for the run, so logs and error labels name what ran. */
export function aiProviderName(options: Options): string {
  return options.experimentalSiwc ? EXPERIMENTAL_OAUTH_PROVIDER : options.ai;
}

/** The provider for a run. Every one it returns is wrapped by
 * `withCopyRule`, so no job reaches a model without the punctuation rule,
 * and by `withSecretMask`, so no secret shape reaches it either. */
export function createAiProvider(
  options: Options,
  model: string,
): AiProvider | undefined {
  return withCopyRule(withSecretMask(createRawProvider(options, model)));
}

function createRawProvider(options: Options, model: string): AiProvider {
  // `--experimental-siwc` wins over `--ai` for the run, `parseArgs` refuses
  // the two together, so this only sees one of them set.
  if (options.experimentalSiwc) {
    return oauthOps(EXPERIMENTAL_OAUTH_PROVIDER).createProvider(model);
  }
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
  // `none` is a choice that parses, so a run gets this far with it. Every
  // guide and every review is written by a provider, so say that plainly.
  const usable = AI_PROVIDERS.filter((provider) => provider !== "none").join(
    "|",
  );
  if (options.ai === "none") {
    die(
      options.command === "init" || options.command === "remake"
        ? `init and sync need an AI provider. Pass --ai=${usable}, or save one with co-maintainer set --ai=...`
        : `This run needs an AI provider. Pass --ai=${usable}`,
    );
  }
  die(
    `${options.ai} is not an AI provider this run can use. Use one of: ${usable}.`,
  );
}

/** A 400 that names one optional part of the request earns one retry without
 * it: the JSON schema, which the prompt asks for anyway, or the reasoning
 * level. Any level can be refused: "none" by a model that always thinks, and
 * any level by a route that cannot carry the field (an OpenCode Go model
 * behind the Responses API, for one). Undefined when nothing is left to drop,
 * so the caller reports the error. */
export function withoutRefusedPart(
  request: AiRequest,
  detail: string,
  schemaPattern: RegExp,
): AiRequest | undefined {
  if (request.responseFormat && schemaPattern.test(detail)) {
    const { responseFormat: _dropped, ...rest } = request;
    return rest;
  }
  if (request.reasoningEffort && /reasoning|effort|thinking/i.test(detail)) {
    const { reasoningEffort: _dropped, ...rest } = request;
    return rest;
  }
  return undefined;
}

/** Marks a response whose request lost its reasoning level on a retry, so the
 * job can say the level it asked for was not used. */
export function noteReasoningDropped(
  sent: AiRequest,
  original: AiRequest,
  response: AiResponse,
): AiResponse {
  if (!original.reasoningEffort || sent.reasoningEffort) return response;
  console.error(
    `[ai] ${response.provider} refused the reasoning level ${original.reasoningEffort} for ${response.model}, retried without it`,
  );
  return { ...response, reasoningDropped: true };
}

/** The model stopped at its output limit before writing a word. Thinking counts
 * toward that limit, so a thinking model can spend all of it there. Without
 * this the empty answer read as a normal one and failed later as "not JSON". */
export function outputLimitError(provider: string, model: string): Error {
  return new OutputLimitError(
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
    ...(choice?.finish_reason === "length" ? { cutOff: true as const } : {}),
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
    // when tools are present, because most providers accept the pair. One that
    // rejects it gets a single retry without the schema (see
    // `OpenRouterProvider.complete`), and the prompt also asks for a fenced
    // JSON block, so a plain-text provider still works.
    ...(request.responseFormat
      ? { response_format: request.responseFormat }
      : {}),
  };
}
