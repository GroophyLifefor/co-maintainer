import { chatBody, parseChatResponse } from "./provider.ts";
import type { AiProvider, AiRequest, AiResponse, Json } from "../types.ts";
import { getEnv } from "../util/runtime.ts";
import { CliError, EXIT_RUNTIME, EXIT_USAGE, networkFailure } from "../cli/error.ts";

/** Provider failures as actionable text (CORE-12, F24/F28). A 401 and a 400 for
 * an unknown model are preconditions the user can fix, so they are usage
 * errors; anything else is a runtime failure. Only the provider's own
 * `error.message` is surfaced: the raw body can carry account metadata
 * (`user_id`) that has no business in a terminal. */
export function openRouterError(
  model: string,
  status: number,
  body: string,
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
      "openrouter_unauthorized",
      "OpenRouter rejected the API key.",
      "Set a new one with co-maintainer set --token=...",
      EXIT_USAGE,
    );
  }
  if (status === 400 && /model/i.test(detail)) {
    return new CliError(
      "openrouter_unknown_model",
      `OpenRouter does not know the model ${model}.`,
      `Pick one at https://openrouter.ai/models and set it with co-maintainer set --high-model=...`,
      EXIT_USAGE,
    );
  }
  return new CliError(
    "openrouter_failed",
    `OpenRouter failed with ${status}${detail ? `: ${detail}` : "."}`,
    undefined,
    EXIT_RUNTIME,
  );
}

export class OpenRouterProvider implements AiProvider {
  readonly supportsTools = true;
  /** `CM_OPENROUTER_URL` points the provider at a local fake in tests. It is
   * only a default override: with the env unset the real endpoint is used, so
   * nothing changes for users. */
  private readonly endpoint =
    getEnv("CM_OPENROUTER_URL") ??
    "https://openrouter.ai/api/v1/chat/completions";
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    if (!apiKey) throw new Error("OpenRouter requires OPENROUTER_API_KEY");
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/GroophyLifefor/co-maintainer",
          "X-Title": "co-maintainer",
        },
        body: JSON.stringify(chatBody(this.model, request)),
      });
    } catch (error) {
      // `fetch failed` alone names neither the host nor the cause (CORE-12).
      throw networkFailure(this.endpoint, error);
    }
    if (!response.ok) {
      throw openRouterError(this.model, response.status, await response.text());
    }
    return parseChatResponse(
      (await response.json()) as Json,
      "openrouter",
      this.model,
    );
  }
}
