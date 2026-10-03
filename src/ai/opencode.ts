/** OpenCode Zen and OpenCode Go, two gateways run by the OpenCode team.
 *
 * Both route each model to its own wire format (Responses, Messages, Chat
 * Completions, Google), and the model list does not say which. Every model is
 * called over Chat Completions instead of keeping a model to format table
 * that goes stale with each new model. A model that refuses it fails with a
 * hint that says so. */
import { randomUUID } from "node:crypto";
import { CliError, EXIT_USAGE } from "../cli/error.ts";
import { getEnv } from "../util/runtime.ts";
import { VERSION } from "../version.ts";
import type { ChatHost } from "./openrouter.ts";
import type { VerifyResult } from "./verify.ts";

export type OpenCodeVariant = "opencode-zen" | "opencode-go";

/** Go asks every client for one session id that stays the same for the run,
 * so one per process. */
const SESSION_ID = randomUUID();

/** `CM_OPENCODE_URL` replaces the origin in tests. Zen and Go differ only in
 * the path under it. */
export function openCodeBase(variant: OpenCodeVariant): string {
  const origin = (getEnv("CM_OPENCODE_URL") ?? "https://opencode.ai").replace(
    /\/$/,
    "",
  );
  return `${origin}${variant === "opencode-go" ? "/zen/go/v1" : "/zen/v1"}`;
}

function displayName(variant: OpenCodeVariant): string {
  return variant === "opencode-go" ? "OpenCode Go" : "OpenCode Zen";
}

export function openCodeHost(variant: OpenCodeVariant): ChatHost {
  return {
    provider: variant,
    name: displayName(variant),
    code: "opencode",
    endpoint: `${openCodeBase(variant)}/chat/completions`,
    // Go wants its own user agent and a stable session id from every client.
    // Zen does not ask, and sending the same pair costs nothing.
    headers: {
      "User-Agent": `co-maintainer/${VERSION}`,
      "x-opencode-session": SESSION_ID,
    },
    modelHint:
      "co-maintainer calls every OpenCode model over Chat Completions. Pick one that supports it from https://opencode.ai/docs/zen and set it with co-maintainer set --high-model=...",
  };
}

/** `/models` is public, so it proves nothing about the key. Only the model is
 * checked here, and a bad key shows up on the first real call. */
export async function verifyOpenCode(
  variant: OpenCodeVariant,
  _apiKey: string,
  model?: string,
): Promise<VerifyResult> {
  if (!model) return { status: "ok" };
  const name = displayName(variant);
  let response: Response;
  try {
    response = await fetch(`${openCodeBase(variant)}/models`);
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return { status: "unreachable", reason: code ?? "network error" };
  }
  if (!response.ok) {
    return {
      status: "unreachable",
      reason: `${name} returned ${response.status}`,
    };
  }
  let rows: unknown;
  try {
    rows = ((await response.json()) as { data?: unknown }).data;
  } catch {
    rows = undefined;
  }
  if (!Array.isArray(rows)) {
    return { status: "unreachable", reason: `${name} returned no model list` };
  }
  if (!rows.some((row) => (row as { id?: string } | null)?.id === model)) {
    return {
      status: "rejected",
      error: new CliError(
        "opencode_unknown_model",
        `${name} does not know the model ${model}.`,
        "Pick one from https://opencode.ai/docs/zen and set it with co-maintainer set --high-model=...",
        EXIT_USAGE,
      ),
    };
  }
  return { status: "ok" };
}
