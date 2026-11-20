/** The global reasoning effort every AI job asks for. One setting for now,
 * `globalReasoningEffort` in config.json, so a model whose provider refuses
 * the reasoning field can still run with `default` or `none`. */
import { readConfig, type UserConfig } from "../config.ts";
import type { AiRequest } from "../types.ts";

export const GLOBAL_REASONING_EFFORTS = [
  "none",
  "low",
  "default",
  "high",
  "xhigh",
  "max",
] as const;

export type GlobalReasoningEffort = (typeof GLOBAL_REASONING_EFFORTS)[number];

export const DEFAULT_GLOBAL_REASONING_EFFORT: GlobalReasoningEffort = "high";

export function isGlobalReasoningEffort(
  value: unknown,
): value is GlobalReasoningEffort {
  return (
    typeof value === "string" &&
    (GLOBAL_REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

/** The configured level. Unset or unknown means the default. */
export function globalReasoningEffort(
  config: UserConfig = readConfig(),
): GlobalReasoningEffort {
  const value = config.globalReasoningEffort;
  return isGlobalReasoningEffort(value)
    ? value
    : DEFAULT_GLOBAL_REASONING_EFFORT;
}

/** The request fields for the configured level, spread into an AI request.
 * `default` sends no reasoning field at all, so the provider uses its own. */
export function reasoningFields(
  config?: UserConfig,
): Pick<AiRequest, "reasoningEffort"> {
  const level = globalReasoningEffort(config);
  return level === "default" ? {} : { reasoningEffort: level };
}
