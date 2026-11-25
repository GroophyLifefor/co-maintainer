import {
  chatBody,
  noteReasoningDropped,
  parseChatResponse,
  withoutRefusedPart,
} from "./provider.ts";
import type { AiProvider, AiRequest, AiResponse, Json } from "../types.ts";
import { getEnv } from "../util/runtime.ts";
import { interruptSignal } from "../util/interrupt.ts";
import { aiTimeoutInit } from "./timeout.ts";
import {
  CliError,
  EXIT_RUNTIME,
  EXIT_USAGE,
  networkFailure,
  readBody,
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
  /** A local server may need no key: then none is required or sent. */
  keyOptional?: boolean;
  /** False keeps the key off the wire, for plain http to another machine. */
  sendKey?: boolean;
  /** The hint for a refused key. Defaults to `set --token`. */
  keyHint?: string;
  /** A 404 means the model or deployment is unknown, as on Azure. */
  notFoundIsUnknownModel?: boolean;
  /** Show only a JSON `error.message`, never a raw body: the address is the
   * user's, and its pages are not ours to print. */
  jsonErrorOnly?: boolean;
  /** Tool calling, when the host has tried it and knows. Defaults to true. */
  supportsTools?: boolean;
  /** The request body, when the host speaks a different dialect of Chat
   * Completions. Defaults to `chatBody`. */
  body?: (model: string, request: AiRequest) => Json;
  /** The request with the part the host refused dropped, or undefined. Asked
   * before the shared schema and reasoning drop. */
  lighter?: (
    request: AiRequest,
    detail: string,
    status: number,
  ) => AiRequest | undefined;
  /** Runs before every request, e.g. the serve egress check. */
  preflight?: (endpoint: string) => Promise<void>;
  /** Extra fetch options, e.g. `redirect: "error"` and a guarded dispatcher.
   * Replaces the plain AI timeout dispatcher when it carries one. */
  init?: () => RequestInit;
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
 * errors. Anything else is a runtime failure. Only the provider's own
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
    detail = host.jsonErrorOnly ? "" : body.trim().slice(0, 200);
  }
  if (status === 401 || status === 403) {
    return new CliError(
      `${host.code}_unauthorized`,
      `${host.name} rejected the API key.`,
      host.keyHint ?? "Set a new one with co-maintainer set --token=...",
      EXIT_USAGE,
    );
  }
  if (
    // "tools are not supported by this model" is about tools, not the name.
    (status === 400 && /model/i.test(detail) && !/\btools?\b/i.test(detail)) ||
    (status === 404 && host.notFoundIsUnknownModel)
  ) {
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
  readonly supportsTools: boolean;
  private readonly host: ChatHost;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(
    apiKey: string,
    model: string,
    host: ChatHost = openRouterHost(),
  ) {
    if (!apiKey && !host.keyOptional) {
      throw new Error(`${host.name} requires an API key`);
    }
    this.supportsTools = host.supportsTools ?? true;
    this.host = host;
    this.apiKey = apiKey;
    this.model = model;
  }

  /** One POST. Returns the raw response so `complete` can decide whether the
   * failure is worth a retry without the schema. */
  private async post(body: Json): Promise<Response> {
    // Outside the try: a config that cannot be read is not a network failure.
    const timeout = aiTimeoutInit();
    await this.host.preflight?.(this.host.endpoint);
    const sendKey = this.apiKey && this.host.sendKey !== false;
    try {
      return await fetch(this.host.endpoint, {
        method: "POST",
        headers: {
          ...(sendKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          "Content-Type": "application/json",
          ...this.host.headers,
        },
        body: JSON.stringify(body),
        signal: interruptSignal(),
        ...timeout,
        ...this.host.init?.(),
      });
    } catch (error) {
      // A redirect could carry the key to another address, so it is refused.
      const cause = (error as { cause?: { message?: string } }).cause;
      if (/redirect/i.test(String(cause?.message ?? ""))) {
        throw new CliError(
          `${this.host.code}_redirect`,
          `${this.host.name} answered with a redirect, which co-maintainer does not follow.`,
          "Set the final address with --ai-base-url.",
          EXIT_USAGE,
        );
      }
      // `fetch failed` alone names neither the host nor the cause.
      throw networkFailure(this.host.endpoint, error);
    }
  }

  private fail(status: number, body: string): CliError {
    return openRouterError(this.model, status, body, this.host);
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    let current = request;
    for (;;) {
      const response = await this.post(
        this.host.body
          ? this.host.body(this.model, current)
          : chatBody(this.model, current),
      );
      if (response.ok) {
        return noteReasoningDropped(
          current,
          request,
          parseChatResponse(
            JSON.parse(await readBody(this.host.endpoint, response)) as Json,
            this.host.provider,
            this.model,
          ),
        );
      }
      const detail = await readBody(this.host.endpoint, response);
      const lighter =
        this.host.lighter?.(current, detail, response.status) ??
        (response.status === 400
          ? withoutRefusedPart(
              current,
              detail,
              /response_format|json_schema|structured/i,
            )
          : undefined);
      if (!lighter) throw this.fail(response.status, detail);
      current = lighter;
    }
  }
}
