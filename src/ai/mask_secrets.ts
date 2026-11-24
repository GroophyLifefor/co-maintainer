/** Secrets in code must not reach the model. Every request is masked here,
 * after the prompt is built and before any provider sends it, so a diff, a
 * file a tool read, a pull request body and the history init reads are all
 * covered, in every mode. Each known secret shape becomes
 * `[redacted:<kind>]`. The mask is a pure function of the text, so a cached
 * prompt prefix stays byte for byte the same. */
import { readConfig, type UserConfig } from "../config.ts";
import type { AiMessage, AiProvider, AiRequest } from "../types.ts";
import { maskSecrets } from "../util/redact.ts";

export function maskSecretsOn(config: UserConfig = readConfig()): boolean {
  return config.maskSecrets !== false;
}

/** The request with every secret masked, and how many distinct values were
 * hidden. The caller's request is not changed. */
export function maskSecretsRequest(request: AiRequest): {
  request: AiRequest;
  count: number;
} {
  const seen = new Set<string>();
  const clean = (text: string): string => {
    const masked = maskSecrets(text);
    for (const value of masked.values) seen.add(value);
    return masked.text;
  };
  const messages = request.messages?.map((message): AiMessage =>
    typeof message.content === "string"
      ? { ...message, content: clean(message.content) }
      : message,
  );
  const masked: AiRequest = {
    ...request,
    prompt: clean(request.prompt),
    ...(request.system === undefined ? {} : { system: clean(request.system) }),
    ...(messages ? { messages } : {}),
  };
  return { request: masked, count: seen.size };
}

/** A provider whose every request is masked first, unless `maskSecrets` is
 * off in the config. The answer says how many secrets were hidden. */
export function withSecretMask(provider: AiProvider): AiProvider {
  return {
    get supportsTools() {
      return provider.supportsTools;
    },
    async complete(request) {
      if (!maskSecretsOn()) return provider.complete(request);
      const { request: masked, count } = maskSecretsRequest(request);
      const response = await provider.complete(masked);
      return count > 0 ? { ...response, secretsMasked: count } : response;
    },
  };
}
