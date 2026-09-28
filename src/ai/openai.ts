/** OpenAI via the Responses API (CORE-105).
 *
 * Chosen over Chat Completions on OpenAI's own advice: "Reasoning models work
 * better with the Responses API" (platform.openai.com/docs/guides/reasoning).
 * Responses has a different shape from the Chat-Completions style the rest of
 * this codebase's `AiRequest`/`AiMessage` types follow (OpenRouter speaks Chat
 * Completions directly), so this file is the one place that translates:
 *
 *  - the system message becomes the top-level `instructions` field
 *  - a tool call is its own `function_call` item, not a field on a message
 *  - a tool's result is a `function_call_output` item, referenced by `call_id`
 *  - a function tool is `{type:"function", name, parameters}`, not nested
 *    under a `function` key
 *  - usage is `input_tokens`/`output_tokens`, not `prompt_tokens`/
 *    `completion_tokens`, and carries no dollar cost at all
 *
 * ponytail: a tool round replays only the function call and its result, not
 * the `reasoning` items a reasoning model's own turn produced alongside them.
 * OpenAI's function-calling guide says those "must also be passed back with
 * tool call outputs" for a reasoning model, so a multi-round tool loop with
 * one (`gpt-6-astra` and similar) may reason less well on later rounds than
 * it could, or in the worst case have a round rejected for missing context.
 * The full fix is `previous_response_id`, which needs a response id to
 * survive between calls, and `AiProvider.complete` is stateless for every
 * provider. Upgrade path: thread a response id through `AiResponse` if this
 * turns out to matter in practice; codegraph's own tool loop caps rounds low
 * (mermaid_loop.ts's `maxToolRounds`), which limits how much is at stake.
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

/** `CM_OPENAI_URL` points at a local fake in tests. Unset means the real
 * endpoint, so production behavior is unchanged. */
export function openAiBase(): string {
  const endpoint =
    getEnv("CM_OPENAI_URL") ?? "https://api.openai.com/v1/responses";
  return endpoint.replace(/\/responses\/?$/, "");
}

/** A failed response as actionable text (CORE-12). Only `error.message` is
 * shown: the raw body can carry request ids that mean nothing in a terminal. */
export function openAiError(
  model: string,
  status: number,
  body: string,
): CliError {
  let detail = "";
  let code = "";
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; code?: string };
    };
    detail = String(parsed.error?.message ?? "");
    code = String(parsed.error?.code ?? "");
  } catch {
    detail = body.trim().slice(0, 200);
  }
  if (status === 401) {
    return new CliError(
      "openai_unauthorized",
      "OpenAI rejected the API key.",
      "Set a new one with co-maintainer set --token=...",
      EXIT_USAGE,
    );
  }
  if (status === 400 && (code === "model_not_found" || /model/i.test(detail))) {
    return new CliError(
      "openai_unknown_model",
      `OpenAI does not know the model ${model}.`,
      "Pick one at https://platform.openai.com/docs/models and set it with co-maintainer set --high-model=...",
      EXIT_USAGE,
    );
  }
  return new CliError(
    "openai_failed",
    `OpenAI failed with ${status}${detail ? `: ${detail}` : "."}`,
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

type ResponsesTool = {
  type: "function";
  name: string;
  description?: string;
  parameters?: unknown;
};

/** `{type:"function",function:{name,parameters}}` (what `mermaid.ts` and the
 * codegraph tools build) to Responses' flat shape. */
function toResponsesTool(tool: Json): ResponsesTool {
  const fn = (tool.function ?? {}) as Json;
  return {
    type: "function",
    name: String(fn.name ?? ""),
    description: fn.description ? String(fn.description) : undefined,
    parameters: fn.parameters,
  };
}

/** A tool call and its result do not live inside a message the way Chat
 * Completions nests them; each is its own item in `input`. */
function toResponsesInput(messages: AiMessage[]): {
  instructions: string | undefined;
  input: Json[];
} {
  const input: Json[] = [];
  let instructions: string | undefined;
  for (const message of messages) {
    if (message.role === "system") {
      instructions = instructions
        ? `${instructions}\n\n${message.content ?? ""}`
        : String(message.content ?? "");
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content ?? "",
      });
      continue;
    }
    if (message.tool_calls?.length) {
      if (message.content) {
        input.push({ role: "assistant", content: message.content });
      }
      for (const call of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    input.push({ role: message.role, content: message.content ?? "" });
  }
  return { instructions, input };
}

function responsesBody(model: string, request: AiRequest): Json {
  const { instructions, input } = toResponsesInput(effectiveMessages(request));
  const schema = request.responseFormat?.json_schema as Json | undefined;
  return {
    model,
    ...(instructions ? { instructions } : {}),
    input,
    max_output_tokens: request.maxTokens,
    ...(request.reasoningEffort
      ? { reasoning: { effort: request.reasoningEffort } }
      : {}),
    ...(request.tools?.length
      ? {
          tools: request.tools.map(toResponsesTool),
          tool_choice: "auto",
        }
      : {}),
    ...(schema
      ? {
          text: {
            format: {
              type: "json_schema",
              name: schema.name,
              schema: schema.schema,
              strict: schema.strict ?? false,
            },
          },
        }
      : {}),
  };
}

type ResponsesOutputItem = {
  type: string;
  content?: { type: string; text?: string; refusal?: string }[];
  call_id?: string;
  name?: string;
  arguments?: string;
};

function parseResponsesBody(json: Json, model: string): AiResponse {
  const output = Array.isArray(json.output)
    ? (json.output as ResponsesOutputItem[])
    : [];
  const texts: string[] = [];
  const toolCalls: AiToolCall[] = [];
  for (const item of output) {
    if (item.type === "function_call" && item.call_id && item.name) {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments ?? "{}" },
      });
      continue;
    }
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "refusal") {
        throw new CliError(
          "openai_refusal",
          `OpenAI refused to answer: ${part.refusal ?? "no reason given"}`,
          undefined,
          EXIT_RUNTIME,
        );
      }
      if (part.type === "output_text" && part.text) texts.push(part.text);
    }
  }
  const usage = json.usage as Json | undefined;
  return {
    text: texts.join(""),
    ...(toolCalls.length ? { toolCalls } : {}),
    tokensIn: Number(usage?.input_tokens ?? 0),
    tokensOut: Number(usage?.output_tokens ?? 0),
    // OpenAI's Responses API reports no dollar cost, so this is always
    // unknown (`costReasonText`'s "provider_did_not_report").
    cost: undefined,
    model,
    provider: "openai",
  };
}

export class OpenAiProvider implements AiProvider {
  readonly supportsTools = true;
  private readonly endpoint = `${openAiBase()}/responses`;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    if (!apiKey) throw new Error("OpenAI requires an API key");
    this.apiKey = apiKey;
    this.model = model;
  }

  private async post(body: Json): Promise<Response> {
    try {
      return await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw networkFailure(this.endpoint, error);
    }
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    let response = await this.post(responsesBody(this.model, request));
    // A model may reject `text.format` next to tools. The schema is only a
    // hint (the prompt also asks for a fenced JSON block), so one retry
    // without it beats failing the review outright (CORE-40).
    if (response.status === 400 && request.responseFormat) {
      const detail = await response.text();
      if (/text\.format|json_schema|structured/i.test(detail)) {
        const { responseFormat: _dropped, ...withoutSchema } = request;
        response = await this.post(responsesBody(this.model, withoutSchema));
        if (response.ok) {
          return parseResponsesBody(
            (await response.json()) as Json,
            this.model,
          );
        }
        throw openAiError(this.model, response.status, await response.text());
      }
      throw openAiError(this.model, response.status, detail);
    }
    if (!response.ok) {
      throw openAiError(this.model, response.status, await response.text());
    }
    return parseResponsesBody((await response.json()) as Json, this.model);
  }
}
