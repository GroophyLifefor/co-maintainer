/** Pre-flight checks for `config set`.
 *
 * A wrong API key or an unknown model used to be accepted by `set` and only
 * surfaced during a review, after the pull request had been fetched and
 * cloned. These call OpenRouter's own `/key` and `/models` endpoints so the
 * mistake is caught the moment it is typed. A network failure is not the
 * user's mistake, so it warns and saves instead of refusing. */
import { CliError, EXIT_USAGE } from "../cli/error.ts";
import { getEnv } from "../util/runtime.ts";
import { openAiBase } from "./openai.ts";
import { anthropicBase, ANTHROPIC_VERSION } from "./anthropic.ts";

/** The chat endpoint the provider uses, with `/chat/completions` removed.
 * `CM_OPENROUTER_URL` points at a local fake in tests, so the base follows it
 * and the verification hits the same server the review would. */
export function openRouterBase(): string {
  const endpoint =
    getEnv("CM_OPENROUTER_URL") ??
    "https://openrouter.ai/api/v1/chat/completions";
  return endpoint.replace(/\/chat\/completions\/?$/, "");
}

export type VerifyResult =
  | { status: "ok" }
  | { status: "unreachable"; reason: string }
  | { status: "rejected"; error: CliError };

async function getJson(
  url: string,
  apiKey: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown } | { unreachable: string }> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: headers ?? { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return { unreachable: code ?? "network error" };
  }
  let body: unknown = undefined;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/** Checks the key against `/key` and, when `model` is given, that `/models`
 * lists it. The first failure decides: a bad key is reported before a model
 * question, since the model check would fail on the key too. */
export async function verifyOpenRouter(
  apiKey: string,
  model?: string,
): Promise<VerifyResult> {
  const base = openRouterBase();
  const key = await getJson(`${base}/key`, apiKey);
  if ("unreachable" in key)
    return { status: "unreachable", reason: key.unreachable };
  if (key.status === 401 || key.status === 403) {
    return {
      status: "rejected",
      error: new CliError(
        "openrouter_unauthorized",
        "OpenRouter rejected the API key.",
        "Check the key at https://openrouter.ai/keys and pass it again.",
        EXIT_USAGE,
      ),
    };
  }
  if (key.status >= 400) {
    return {
      status: "unreachable",
      reason: `OpenRouter returned ${key.status}`,
    };
  }
  if (!model) return { status: "ok" };
  const models = await getJson(`${base}/models`, apiKey);
  if ("unreachable" in models) {
    return { status: "unreachable", reason: models.unreachable };
  }
  const rows = (models.body as { data?: { id?: string }[] } | undefined)?.data;
  if (!Array.isArray(rows)) {
    return {
      status: "unreachable",
      reason: "OpenRouter returned no model list",
    };
  }
  if (!rows.some((row) => row?.id === model)) {
    return {
      status: "rejected",
      error: new CliError(
        "openrouter_unknown_model",
        `OpenRouter does not know the model ${model}.`,
        "Pick one at https://openrouter.ai/models and set it with co-maintainer set --high-model=...",
        EXIT_USAGE,
      ),
    };
  }
  return { status: "ok" };
}

/** Same shape as {@link verifyOpenRouter}: `/models` both authenticates the
 * key and, when `model` is given, confirms OpenAI actually has it. */
export async function verifyOpenAi(
  apiKey: string,
  model?: string,
): Promise<VerifyResult> {
  const base = openAiBase();
  const models = await getJson(`${base}/models`, apiKey);
  if ("unreachable" in models) {
    return { status: "unreachable", reason: models.unreachable };
  }
  if (models.status === 401) {
    return {
      status: "rejected",
      error: new CliError(
        "openai_unauthorized",
        "OpenAI rejected the API key.",
        "Check the key at https://platform.openai.com/api-keys and pass it again.",
        EXIT_USAGE,
      ),
    };
  }
  if (models.status >= 400) {
    return {
      status: "unreachable",
      reason: `OpenAI returned ${models.status}`,
    };
  }
  if (!model) return { status: "ok" };
  const rows = (models.body as { data?: { id?: string }[] } | undefined)?.data;
  if (!Array.isArray(rows)) {
    return { status: "unreachable", reason: "OpenAI returned no model list" };
  }
  if (!rows.some((row) => row?.id === model)) {
    return {
      status: "rejected",
      error: new CliError(
        "openai_unknown_model",
        `OpenAI does not know the model ${model}.`,
        "Pick one at https://platform.openai.com/docs/models and set it with co-maintainer set --high-model=...",
        EXIT_USAGE,
      ),
    };
  }
  return { status: "ok" };
}

/** Anthropic authenticates the key and lists models at `/models`, but with its
 * own headers (`x-api-key` + `anthropic-version`) instead of a Bearer token.
 * Without a model the call only proves the key; with one it also confirms
 * Anthropic serves it. */
export async function verifyAnthropic(
  apiKey: string,
  model?: string,
): Promise<VerifyResult> {
  const base = anthropicBase();
  const models = await getJson(`${base}/models`, apiKey, {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  });
  if ("unreachable" in models) {
    return { status: "unreachable", reason: models.unreachable };
  }
  if (models.status === 401 || models.status === 403) {
    return {
      status: "rejected",
      error: new CliError(
        "anthropic_unauthorized",
        "Anthropic rejected the API key.",
        "Check the key at https://console.anthropic.com/settings/keys and pass it again.",
        EXIT_USAGE,
      ),
    };
  }
  if (models.status >= 400) {
    return {
      status: "unreachable",
      reason: `Anthropic returned ${models.status}`,
    };
  }
  if (!model) return { status: "ok" };
  const rows = (models.body as { data?: { id?: string }[] } | undefined)?.data;
  if (!Array.isArray(rows)) {
    return {
      status: "unreachable",
      reason: "Anthropic returned no model list",
    };
  }
  if (!rows.some((row) => row?.id === model)) {
    return {
      status: "rejected",
      error: new CliError(
        "anthropic_unknown_model",
        `Anthropic does not know the model ${model}.`,
        "Pick one at https://docs.anthropic.com/en/docs/about-claude/models and set it with co-maintainer set --high-model=...",
        EXIT_USAGE,
      ),
    };
  }
  return { status: "ok" };
}
