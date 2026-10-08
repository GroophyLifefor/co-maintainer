import { chatBody, parseChatResponse } from "./provider.ts";
import type { AiProvider, AiRequest, AiResponse, Json } from "../types.ts";
import { getEnv } from "../util/runtime.ts";
import {
  CliError,
  EXIT_RUNTIME,
  EXIT_USAGE,
  networkFailure,
} from "../cli/error.ts";

/** A service that speaks OpenAI-compatible Chat Completions. OpenRouter is
 * one, OpenCode Zen and OpenCode Go are the others, so they share this client
 * and differ only in where they live and how they name themselves. */
export type ChatHost = {
  provider: AiResponse["provider"];
  /** Shown in every message, e.g. `OpenCode Zen rejected the API key.` */
  name: string;
  /** Prefix of the error codes, e.g. `openrouter_unauthorized`. */
  code: string;
  endpoint: string;
  headers: Record<string, string>;
  /** The hint for a model the host refuses. */
  modelHint: string;
};

/** `CM_OPENROUTER_URL` points the provider at a local fake in tests. It is
 * only a default override: with the env unset the real endpoint is used, so
 * nothing changes for users. */
export function openRouterHost(): ChatHost {
  return {
    provider: "openrouter",
    name: "OpenRouter",
    code: "openrouter",
    endpoint:
      getEnv("CM_OPENROUTER_URL") ??
      "https://openrouter.ai/api/v1/chat/completions",
    headers: {
      "HTTP-Referer": "https://github.com/GroophyLifefor/co-maintainer",
      "X-Title": "co-maintainer",
    },
    modelHint:
      "Pick one at https://openrouter.ai/models and set it with co-maintainer set --high-model=...",
  };
}

/** Provider failures as actionable text. A 401 and a 400 for
 * an unknown model are preconditions the user can fix, so they are usage
 * errors; anything else is a runtime failure. Only the provider's own
 * `error.message` is surfaced: the raw body can carry account metadata
 * (`user_id`) that has no business in a terminal. */
export function openRouterError(
  model: string,
  status: number,
  body: string,
  host: ChatHost = openRouterHost(),
): CliError {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    detail = String(parsed.error?.message ?? "");
  } catch {
    detail = body.trim().slice(0, 200);
  }
  if (status === 401 || status === 403) {
    return new CliError(
      `${host.code}_unauthorized`,
      `${host.name} rejected the API key.`,
      "Set a new one with co-maintainer set --token=...",
      EXIT_USAGE,
    );
  }
  if (status === 400 && /model/i.test(detail)) {
    return new CliError(
      `${host.code}_unknown_model`,
      `${host.name} does not know the model ${model}.`,
      host.modelHint,
      EXIT_USAGE,
    );
  }
  return new CliError(
    `${host.code}_failed`,
    `${host.name} failed with ${status}${detail ? `: ${detail}` : "."}`,
    undefined,
    EXIT_RUNTIME,
  );
}

export class OpenRouterProvider implements AiProvider {
  readonly supportsTools = true;
  private readonly host: ChatHost;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(
    apiKey: string,
    model: string,
    host: ChatHost = openRouterHost(),
  ) {
    if (!apiKey) throw new Error(`${host.name} requires an API key`);
    this.host = host;
    this.apiKey = apiKey;
    this.model = model;
  }

  /** One POST. Returns the raw response so `complete` can decide whether the
   * failure is worth a retry without the schema. */
  private async post(body: Json): Promise<Response> {
    try {
      return await fetch(this.host.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...this.host.headers,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // `fetch failed` alone names neither the host nor the cause.
      throw networkFailure(this.host.endpoint, error);
    }
  }

  private fail(status: number, body: string): CliError {
    return openRouterError(this.model, status, body, this.host);
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    let response = await this.post(chatBody(this.model, request));
    // A provider may refuse `response_format` next to `tools`. The schema is
    // only a hint — the prompt also asks for a fenced JSON block — so one
    // retry without it is better than failing the review.
    if (response.status === 400 && request.responseFormat) {
      const detail = await response.text();
      if (/response_format|json_schema|structured/i.test(detail)) {
        const { responseFormat: _dropped, ...withoutSchema } = request;
        response = await this.post(chatBody(this.model, withoutSchema));
        if (response.ok) {
          return parseChatResponse(
            (await response.json()) as Json,
            this.host.provider,
            this.model,
          );
        }
        throw this.fail(response.status, await response.text());
      }
      throw this.fail(response.status, detail);
    }
    if (!response.ok) {
      throw this.fail(response.status, await response.text());
    }
    return parseChatResponse(
      (await response.json()) as Json,
      this.host.provider,
      this.model,
    );
  }
}
