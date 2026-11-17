import type {
  AiMessage,
  AiProvider,
  AiRequest,
  AiResponse,
  AiToolCall,
  Json,
} from "../types.ts";
import { MERMAID_TOOL, readMermaidSyntaxes } from "./mermaid.ts";
import { ToolGate } from "./tool_gate.ts";
import { log } from "../util/log.ts";

const DEFAULT_MAX_TOOL_ROUNDS = 3;
const TOOL_NAME = "read-mermaid-syntaxes";

/** Async because a review's tools shell out or hit disk, unlike the built-in
 * Mermaid doc lookup. */
export type ToolHandler = {
  tool: Json;
  name: string;
  run: (args: unknown) => Promise<string> | string;
  /** The result comes from outside the repository, so the gate puts the
   * fixed data line before it. */
  external?: boolean;
};

async function runTool(
  call: AiToolCall,
  maxTools: number,
  extraTools: ToolHandler[],
): Promise<string> {
  try {
    if (call.function.name === TOOL_NAME) {
      return readMermaidSyntaxes(JSON.parse(call.function.arguments), maxTools);
    }
    const extra = extraTools.find((item) => item.name === call.function.name);
    if (extra) return await extra.run(JSON.parse(call.function.arguments));
    throw new Error(`unsupported tool: ${call.function.name}`);
  } catch (error) {
    return `Tool error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** A Stop between tool rounds. `partial` holds the merged usage of the calls
 * made before it, so their cost is not lost. */
export type StoppedLoopError = DOMException & { partial?: AiResponse };

function stoppedWith(partial: AiResponse | undefined): StoppedLoopError {
  const error = new DOMException("Aborted", "AbortError") as StoppedLoopError;
  if (partial) error.partial = partial;
  return error;
}

export async function completeWithMermaidTools(
  provider: AiProvider,
  request: AiRequest,
  maxTools: number,
  extraTools: ToolHandler[] = [],
  maxToolRounds: number = DEFAULT_MAX_TOOL_ROUNDS,
  options: {
    signal?: AbortSignal;
    onResponse?: (response: AiResponse) => void | Promise<void>;
    /** The review's gate. Left out, results are not limited. */
    gate?: ToolGate;
  } = {},
): Promise<AiResponse> {
  const gate = options.gate ?? new ToolGate();
  if (provider.supportsTools === false) {
    const response = await provider.complete(request);
    if (options.onResponse) await options.onResponse(response);
    return response;
  }

  const messages: AiMessage[] = [
    ...(request.messages ?? [
      ...(request.system
        ? [{ role: "system" as const, content: request.system }]
        : []),
      { role: "user" as const, content: request.prompt },
    ]),
  ];
  const tools = [
    ...(request.withoutMermaidTool ? [] : [MERMAID_TOOL as unknown as Json]),
    ...extraTools.map((item) => item.tool),
  ];
  const totals = {
    tokensIn: 0,
    tokensOut: 0,
    cost: undefined as number | undefined,
  };
  const calls = { known: 0, unknown: 0 };
  const merge = (response: AiResponse): AiResponse => {
    totals.tokensIn += response.tokensIn;
    totals.tokensOut += response.tokensOut;
    if (response.cost === undefined) calls.unknown++;
    else {
      calls.known++;
      totals.cost = (totals.cost ?? 0) + response.cost;
    }
    return {
      ...response,
      ...totals,
      cost: calls.unknown === 0 ? totals.cost : undefined,
      costCalls: { ...calls },
    };
  };

  let sofar: AiResponse | undefined;
  for (let round = 0; round < maxToolRounds; round++) {
    if (options.signal?.aborted) {
      // The calls this loop already made are paid. They ride on the error
      // so the caller can still record their cost.
      throw stoppedWith(sofar);
    }
    const response = await provider.complete({ ...request, messages, tools });
    if (options.onResponse) await options.onResponse(response);
    if (!response.toolCalls?.length) return merge(response);
    sofar = merge(response);
    gate.round();
    log(
      "review-tools",
      `round ${
        round + 1
      }/${maxToolRounds} · ${response.toolCalls.length} call(s): ${response.toolCalls
        .map((call) => call.function.name)
        .join(", ")}`,
    );
    messages.push({
      role: "assistant",
      content: response.text || null,
      tool_calls: response.toolCalls,
    });
    const ran = await Promise.all(
      response.toolCalls.map(async (call) => {
        const refused = gate.refuse(call.function.name);
        const raw = refused ?? (await runTool(call, maxTools, extraTools));
        log(
          "review-tools",
          `${call.function.name}(${call.function.arguments}) → ${raw.length} chars${
            raw.startsWith("Tool error") || raw.startsWith("codegraph ")
              ? `: ${raw.slice(0, 200)}`
              : ""
          }`,
        );
        return { call, raw, refused: refused !== undefined };
      }),
    );
    // The gate counts in call order, so the budget is spent the same way
    // whichever tool finished first.
    const results = ran.map(({ call, raw, refused }) => ({
      call,
      result: gate.accept(call.function.name, raw, {
        refused,
        external: extraTools.find((item) => item.name === call.function.name)
          ?.external,
      }),
    }));
    for (const { call, result } of results) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: result,
      });
    }
  }
  log(
    "review-tools",
    `round budget (${maxToolRounds}) exhausted with the model still requesting tools`,
  );
  messages.push({
    role: "user",
    content:
      "No more tool calls are available. Answer now using only what you already found.",
  });
  const final = await provider.complete({ ...request, messages });
  if (options.onResponse) await options.onResponse(final);
  return merge(final);
}
