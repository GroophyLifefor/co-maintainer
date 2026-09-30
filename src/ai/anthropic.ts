/** Anthropic via the Messages API.
 *
 * The raw fetch shape every other provider uses, against Anthropic's own
 * contract (docs.anthropic.com/en/api/messages). The request/response shapes
 * differ from the Chat-Completions style this codebase's `AiRequest`/
 * `AiMessage` types follow the way OpenAI's Responses API does, so this file is
 * the one place that translates:
 *
 *  - the system message becomes the top-level `system` field, not a message
 *  - an assistant tool call is a `tool_use` content block, not a `tool_calls`
 *    field on the message
 *  - tool results are `tool_result` blocks inside a `user` message, referenced
 *    by `tool_use_id`
 *  - a function tool is `{name, description, input_schema}`, not the
 *    Chat-Completions `{type:"function", function:{...}}` nesting
 *  - structured output is `output_config.format`, reasoning effort is
 *    `output_config.effort`, and there is no `temperature`: Claude Opus 5 and
 *    Sonnet 5 reject sampling parameters with a 400
 *
 * `cache_control` is set on the system prompt, which every review sends as the
 * same guide prefix. Anthropic caches the longest stable prefix, so the
 * guides are billed at the cached rate from the second review on and the
 * `cache_read_input_tokens` count shows up in the usage log.
 *
 * ponytail: this talks to Messages without streaming. The original design
 * called for the SDK's `stream()` + `finalMessage()` helper for large `max_tokens` (a single
 * review can ask for 96k). The SDK is not a dependency (kept fetch-only, the
 * same as every other provider), and a hand-rolled SSE accumulation loop is a
 * lot of code for a first cut. Anthropic's HTTP request timeout is the risk;
 * if a real review ever hits it, add the streaming loop here. Upgrade path:
 * `stream:true` + parse `content_block_delta` events into the same
 * `parseMessagesBody` result shape.
 */
import type {
  AiMessage,
  AiProvider,
  AiRequest,
  AiResponse,
  AiToolCall,
  Json,
} from "../types.ts";
import { getEnv } from "../util/runtime.ts";
import {
  CliError,
  EXIT_RUNTIME,
  EXIT_USAGE,
  networkFailure,
} from "../cli/error.ts";

/** Required on every Messages request and the only version the errors below
 * are written against. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** `CM_ANTHROPIC_URL` points at a local fake in tests. Unset means the real
 * endpoint, so production behavior is unchanged. */
export function anthropicBase(): string {
  const endpoint = getEnv("CM_ANTHROPIC_URL") ?? "https://api.anthropic.com/v1";
  return endpoint.replace(/\/$/, "");
}

/** A failed response as actionable text. Only the error's own
 * `message` is surfaced: the raw body can carry request ids that mean nothing
 * in a terminal. */
export function anthropicError(
  model: string,
  status: number,
  body: string,
): CliError {
  let detail = "";
  let type = "";
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; type?: string };
    };
    detail = String(parsed.error?.message ?? "");
    type = String(parsed.error?.type ?? "");
  } catch {
    detail = body.trim().slice(0, 200);
  }
  if (status === 401 || status === 403) {
    return new CliError(
      "anthropic_unauthorized",
      "Anthropic rejected the API key.",
      "Set a new one with co-maintainer set --token=...",
      EXIT_USAGE,
    );
  }
  if (
    (status === 400 || status === 404) &&
    (type === "not_found_error" || /model/i.test(detail))
  ) {
    return new CliError(
      "anthropic_unknown_model",
      `Anthropic does not know the model ${model}.`,
      "Pick one at https://docs.anthropic.com/en/docs/about-claude/models and set it with co-maintainer set --high-model=...",
      EXIT_USAGE,
    );
  }
  return new CliError(
    "anthropic_failed",
    `Anthropic failed with ${status}${detail ? `: ${detail}` : "."}`,
    undefined,
    EXIT_RUNTIME,
  );
}

/** The Chat-Completions-shaped message list every caller already builds
 * (`chatBody` does the same fallback for OpenRouter). */
function effectiveMessages(request: AiRequest): AiMessage[] {
  return (
    request.messages ?? [
      ...(request.system
        ? [{ role: "system" as const, content: request.system }]
        : []),
      { role: "user" as const, content: request.prompt },
    ]
  );
}

type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: unknown;
};

/** `{type:"function",function:{name,parameters}}` (what `mermaid.ts` and the
 * codegraph tools build) to Anthropic's `input_schema` shape. */
function toAnthropicTool(tool: Json): AnthropicTool {
  const fn = (tool.function ?? {}) as Json;
  return {
    name: String(fn.name ?? ""),
    description: fn.description ? String(fn.description) : undefined,
    input_schema: fn.parameters ?? { type: "object" },
  };
}

type AnthropicBlock = Json & { type: string };

/** A tool call and its result do not live inside a message the way Chat
 * Completions nests them. Anthropic delivers `tool_use` blocks in the
 * assistant turn, and the caller must send every result back in a single
 * `user` message with one `tool_result` block each, in the same order. */
function toAnthropicMessages(messages: AiMessage[]): {
  system: string | undefined;
  messages: Json[];
} {
  const system: string[] = [];
  const out: Json[] = [];
  // Consecutive `tool` messages collapse into one `user` turn: Anthropic
  // rejects two user messages in a row.
  let pendingResults: AnthropicBlock[] = [];
  const flushResults = (): void => {
    if (!pendingResults.length) return;
    out.push({ role: "user", content: pendingResults });
    pendingResults = [];
  };
  for (const message of messages) {
    if (message.role === "system") {
      system.push(String(message.content ?? ""));
      continue;
    }
    if (message.role === "tool") {
      pendingResults.push({
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? "",
        content: message.content ?? "",
      });
      continue;
    }
    flushResults();
    if (message.tool_calls?.length) {
      const content: AnthropicBlock[] = [];
      if (message.content)
        content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments) as unknown;
        } catch {
          input = {};
        }
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input,
        });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    out.push({ role: message.role, content: message.content ?? "" });
  }
  flushResults();
  return {
    system: system.length ? system.join("\n\n") : undefined,
    messages: out,
  };
}

/** Haiku 4.5 does not support `output_config.effort`; sending it is a 400.
 * Anthropic's effort accepts low/medium/high/xhigh/max, so the only level this
 * has to drop is "none": it means "reasoning off" in `AiRequest` and is not an
 * effort value Anthropic lists. */
function supportsEffort(model: string): boolean {
  return !/haiku/i.test(model);
}

function messagesBody(model: string, request: AiRequest): Json {
  const { system, messages } = toAnthropicMessages(effectiveMessages(request));
  const schema = request.responseFormat?.json_schema as Json | undefined;
  const effort =
    request.reasoningEffort && request.reasoningEffort !== "none"
      ? request.reasoningEffort
      : undefined;
  // `output_config` carries both the structured-output schema and the effort
  // level. It is only sent when one of them applies, so a plain request stays
  // on the request shape every model understands.
  const outputConfig = {
    ...(schema?.schema
      ? { format: { type: "json_schema", schema: schema.schema } }
      : {}),
    ...(effort && supportsEffort(model) ? { effort } : {}),
  };
  return {
    model,
    max_tokens: request.maxTokens,
    // `cache_control` marks the guide prefix every review repeats, so it is
    // read from cache instead of re-billed.
    ...(system
      ? {
          system: [
            {
              type: "text",
              text: system,
              cache_control: { type: "ephemeral" },
            },
          ],
        }
      : {}),
    messages,
    ...(request.tools?.length
      ? {
          tools: request.tools.map(toAnthropicTool),
          tool_choice: { type: "auto" },
        }
      : {}),
    ...(Object.keys(outputConfig).length
      ? { output_config: outputConfig }
      : {}),
  };
}

type AnthropicContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
};

/** `refusal` stop reason with the human-readable explanation when Anthropic
 * supplies one. Kept here so both the non-streaming body and any future
 * streaming loop share one message. */
function refusalError(details: Json | undefined): CliError {
  const explanation =
    details && typeof details.explanation === "string"
      ? details.explanation
      : "no reason given";
  return new CliError(
    "anthropic_refusal",
    `Anthropic refused to answer: ${explanation}`,
    undefined,
    EXIT_RUNTIME,
  );
}

export function parseMessagesBody(json: Json, model: string): AiResponse {
  const stopReason = String(json.stop_reason ?? "");
  if (stopReason === "refusal") {
    throw refusalError(json.stop_details as Json | undefined);
  }
  const content = Array.isArray(json.content)
    ? (json.content as AnthropicContentBlock[])
    : [];
  const texts: string[] = [];
  const toolCalls: AiToolCall[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      texts.push(block.text);
      continue;
    }
    if (block.type === "tool_use" && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  const usage = json.usage as Json | undefined;
  return {
    text: texts.join(""),
    ...(toolCalls.length ? { toolCalls } : {}),
    tokensIn: Number(usage?.input_tokens ?? 0),
    tokensOut: Number(usage?.output_tokens ?? 0),
    // Anthropic reports only token counts, never a dollar cost, so this is
    // always unknown (`costReasonText`'s "provider_did_not_report").
    cost: undefined,
    model,
    provider: "anthropic",
  };
}

export class AnthropicProvider implements AiProvider {
  readonly supportsTools = true;
  private readonly endpoint = `${anthropicBase()}/messages`;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    if (!apiKey) throw new Error("Anthropic requires an API key");
    this.apiKey = apiKey;
    this.model = model;
  }

  private async post(body: Json): Promise<Response> {
    try {
      return await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw networkFailure(this.endpoint, error);
    }
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    let response = await this.post(messagesBody(this.model, request));
    // A model may reject `output_config.format` next to tools. The schema is
    // only a hint (the prompt also asks for a fenced JSON block), so one retry
    // without it beats failing the review outright.
    if (response.status === 400 && request.responseFormat) {
      const detail = await response.text();
      if (/output_config|json_schema|structured/i.test(detail)) {
        const { responseFormat: _dropped, ...withoutSchema } = request;
        response = await this.post(messagesBody(this.model, withoutSchema));
        if (response.ok) {
          return parseMessagesBody((await response.json()) as Json, this.model);
        }
        throw anthropicError(
          this.model,
          response.status,
          await response.text(),
        );
      }
      throw anthropicError(this.model, response.status, detail);
    }
    if (!response.ok) {
      throw anthropicError(this.model, response.status, await response.text());
    }
    return parseMessagesBody((await response.json()) as Json, this.model);
  }
}
