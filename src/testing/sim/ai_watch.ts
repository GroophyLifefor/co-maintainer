/** Which AI job a request belongs to, and what each `complete()` returned.
 *
 * The job name (`review_pull_request`, `synth_section`) is not in the HTTP
 * body a provider sends, yet a flow scripts the fake AI by it and the checks
 * group calls by it. So the provider classes' `complete` is wrapped while a
 * flow runs: the request's job is kept in an `AsyncLocalStorage` the caught
 * fetch reads, and the call's result is recorded in the trace. The wrapper
 * calls the real method and changes nothing it returns or throws. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AiMessage, AiRequest, AiResponse } from "../../types.ts";
import type { Trace } from "./trace.ts";

const current = new AsyncLocalStorage<string>();

/** The job of the AI request this code runs inside, if any. */
export function currentAiJob(): string | undefined {
  return current.getStore();
}

type Complete = (request: AiRequest) => Promise<AiResponse>;
type ProviderClass = { prototype: { complete: Complete } };

function systemOf(request: AiRequest): string {
  const messages: AiMessage[] = request.messages ?? [];
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => String(message.content ?? ""));
  return request.messages ? system.join("\n") : (request.system ?? "");
}

function firstUserOf(request: AiRequest): string {
  const user = request.messages?.find((message) => message.role === "user");
  return user ? String(user.content ?? "") : request.prompt;
}

/** Wraps every API-key provider until the returned function is called.
 * Imported here, after the world set the env, like every product module. */
export async function watchAi(trace: Trace): Promise<() => void> {
  const providers: ProviderClass[] = [
    (await import("../../ai/openrouter.ts")).OpenRouterProvider,
    (await import("../../ai/openai.ts")).OpenAiProvider,
    (await import("../../ai/anthropic.ts")).AnthropicProvider,
  ];
  const originals = providers.map((provider) => provider.prototype.complete);
  providers.forEach((provider, index) => {
    const original = originals[index]!;
    provider.prototype.complete = async function (request) {
      const startMs = trace.now();
      const step = trace.step;
      const base = {
        step,
        startMs,
        job: request.job,
        system: systemOf(request),
        firstUser: firstUserOf(request),
      };
      try {
        const response = await current.run(request.job, () =>
          original.call(this, request),
        );
        trace.completions.push({
          ...base,
          ok: true,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          cost: response.cost ?? null,
          toolCalls: response.toolCalls?.length ?? 0,
        });
        return response;
      } catch (error) {
        trace.completions.push({
          ...base,
          ok: false,
          tokensIn: 0,
          tokensOut: 0,
          cost: null,
          toolCalls: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
  });
  return () => {
    providers.forEach((provider, index) => {
      provider.prototype.complete = originals[index]!;
    });
  };
}
