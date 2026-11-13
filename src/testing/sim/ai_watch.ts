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

/** One `complete()` in progress: its job, and the usage every HTTP answer
 * inside it reported, which the provider bills even when the product then
 * throws (an output limit, a cut-off body). */
type Call = { job: string; billedIn: number; billedOut: number; seen: boolean };

const current = new AsyncLocalStorage<Call>();

/** The job of the AI request this code runs inside, if any. */
export function currentAiJob(): string | undefined {
  return current.getStore()?.job;
}

/** Adds the usage an HTTP answer reported to the call it belongs to. Only
 * OpenRouter's shape (`prompt_tokens`) is read: for another provider the
 * product's own count stands in. */
export function recordBilledUsage(body: unknown): void {
  const call = current.getStore();
  const usage = (body as { usage?: Record<string, unknown> } | null)?.usage;
  if (!call || typeof usage?.prompt_tokens !== "number") return;
  call.seen = true;
  call.billedIn += usage.prompt_tokens;
  call.billedOut += Number(usage.completion_tokens ?? 0);
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

/** The tool calls this request answers with tool results. */
function answersOf(request: AiRequest): string[] {
  return (request.messages ?? [])
    .filter((message) => message.role === "tool" && message.tool_call_id)
    .map((message) => message.tool_call_id!);
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
      const call: Call = {
        job: request.job,
        billedIn: 0,
        billedOut: 0,
        seen: false,
      };
      const base = {
        step: trace.step,
        startMs: trace.now(),
        job: request.job,
        system: systemOf(request),
        firstUser: firstUserOf(request),
        answers: answersOf(request),
      };
      try {
        const response = await current.run(call, () =>
          original.call(this, request),
        );
        trace.completions.push({
          ...base,
          ok: true,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          billedIn: call.seen ? call.billedIn : response.tokensIn,
          billedOut: call.seen ? call.billedOut : response.tokensOut,
          cost: response.cost ?? null,
          toolCalls: response.toolCalls?.length ?? 0,
          toolCallIds: (response.toolCalls ?? []).map((tool) => tool.id),
        });
        return response;
      } catch (error) {
        trace.completions.push({
          ...base,
          ok: false,
          tokensIn: 0,
          tokensOut: 0,
          billedIn: call.billedIn,
          billedOut: call.billedOut,
          cost: null,
          toolCalls: 0,
          toolCallIds: [],
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
