import type {
  AiMessage,
  AiProvider,
  AiRequest,
  AiResponse,
  AiToolCall,
  Json,
} from "../types.ts";
import { MERMAID_TOOL, readMermaidSyntaxes } from "./mermaid.ts";
import { log } from "../util/log.ts";

const DEFAULT_MAX_TOOL_ROUNDS = 3;
const TOOL_NAME = "read-mermaid-syntaxes";

/** Async because a review's tools shell out or hit disk, unlike the built-in
 * Mermaid doc lookup. */
export type ToolHandler = {
  tool: Json;
  name: string;
  run: (args: unknown) => Promise<string> | string;
};

async function runTool(
  call: AiToolCall,
  maxTools: number,
  extraTools: ToolHandler[],
): Promise<string> {
  try {
    if (call.function.name === TOOL_NAME) {
      return readMermaidSyntaxes(
        JSON.parse(call.function.arguments),
        maxTools,
      );
    }
    const extra = extraTools.find((item) => item.name === call.function.name);
    if (extra) return await extra.run(JSON.parse(call.function.arguments));
    throw new Error(`unsupported tool: ${call.function.name}`);
  } catch (error) {
    return `Tool error: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

export async function completeWithMermaidTools(
  provider: AiProvider,
  request: AiRequest,
  maxTools: number,
  extraTools: ToolHandler[] = [],
  maxToolRounds: number = DEFAULT_MAX_TOOL_ROUNDS,
): Promise<AiResponse> {
  if (provider.supportsTools === false) return provider.complete(request);

  const messages: AiMessage[] = [
    ...request.messages ?? [
      ...(request.system
        ? [{ role: "system" as const, content: request.system }]
        : []),
      { role: "user" as const, content: request.prompt },
    ],
  ];
  const tools = [
    MERMAID_TOOL as unknown as Json,
    ...extraTools.map((item) => item.tool),
  ];
  const totals = {
    tokensIn: 0,
    tokensOut: 0,
    cost: undefined as number | undefined,
  };
  let costKnown = true;
  const merge = (response: AiResponse): AiResponse => {
    totals.tokensIn += response.tokensIn;
    totals.tokensOut += response.tokensOut;
    // A missing cost is unknown, not zero, so one silent round makes the whole
    // total unknown rather than an understated number.
    if (response.cost === undefined) costKnown = false;
    else if (costKnown) totals.cost = (totals.cost ?? 0) + response.cost;
    return {
      ...response,
      ...totals,
      cost: costKnown ? totals.cost : undefined,
    };
  };

  for (let round = 0; round < maxToolRounds; round++) {
    const response = await provider.complete({ ...request, messages, tools });
    if (!response.toolCalls?.length) return merge(response);
    merge(response);
    log(
      "review-tools",
      `round ${
        round + 1
      }/${maxToolRounds} · ${response.toolCalls.length} call(s): ${
        response.toolCalls.map((call) => call.function.name).join(", ")
      }`,
    );
    messages.push({
      role: "assistant",
      content: response.text || null,
      tool_calls: response.toolCalls,
    });
    for (const call of response.toolCalls) {
      const result = await runTool(call, maxTools, extraTools);
      log(
        "review-tools",
        `${call.function.name}(${call.function.arguments}) → ${result.length} chars${
          result.startsWith("Tool error") || result.startsWith("codegraph ")
            ? `: ${result.slice(0, 200)}`
            : ""
        }`,
      );
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: result,
      });
    }
  }
  // The model still wanted tools past the round budget — dropping `tools`
  // silently here made past runs hallucinate fake tool-call syntax as text
  // instead of a real finding (verified via a tokio benchmark run). Telling
  // it plainly is cheap insurance against that.
  log(
    "review-tools",
    `round budget (${maxToolRounds}) exhausted with the model still requesting tools`,
  );
  messages.push({
    role: "user",
    content:
      "No more tool calls are available. Answer now using only what you already found.",
  });
  return merge(await provider.complete({ ...request, messages }));
}
