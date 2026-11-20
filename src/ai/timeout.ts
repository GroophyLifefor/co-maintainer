/** How long one AI request may wait for the provider. Node's own `fetch`
 * gives up after 300 seconds without response headers, which a thinking
 * model on a large pull request can outlast, so every AI call goes through a
 * dispatcher with the configured limit instead. */
import { Agent } from "undici";
import { readConfig, type UserConfig } from "../config.ts";

export const DEFAULT_AI_TIMEOUT_MINUTES = 15;

/** The configured limit in milliseconds. Unset, zero, negative or not a
 * number means the default. */
export function aiTimeoutMs(config: UserConfig = readConfig()): number {
  const minutes = config.aiTimeoutMinutes;
  const valid =
    typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0;
  return (valid ? minutes : DEFAULT_AI_TIMEOUT_MINUTES) * 60_000;
}

let cached: { ms: number; agent: Agent } | undefined;

/** One dispatcher per limit, rebuilt only when the setting changes, so a
 * dashboard edit applies to the next AI call without a restart. The limit
 * covers both the wait for headers and any silence inside the body. */
export function aiDispatcher(ms: number = aiTimeoutMs()): Agent {
  if (cached?.ms === ms) return cached.agent;
  const previous = cached?.agent;
  cached = { ms, agent: new Agent({ headersTimeout: ms, bodyTimeout: ms }) };
  // Requests already running on the old one finish first.
  void previous?.close().catch(() => {});
  return cached.agent;
}

/** The `fetch` option that applies the limit. Node's `fetch` reads
 * `dispatcher`, which the DOM `RequestInit` type does not name, hence the
 * cast. Spread it into an AI call's init. */
export function aiTimeoutInit(): RequestInit {
  return { dispatcher: aiDispatcher() } as unknown as RequestInit;
}
