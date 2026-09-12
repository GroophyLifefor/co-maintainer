import type {
  AiMessage,
  AiProvider,
  AiRequest,
  AiResponse,
  AiToolCall,
  Json,
} from "../types.ts";
import { MERMAID_TOOL, readMermaidSyntaxes } from "./mermaid.ts";

const MAX_TOOL_ROUNDS = 3;
const TOOL_NAME = "read-mermaid-syntaxes";

function runTool(call: AiToolCall, maxTools: number): string {
  try {
    if (call.function.name !== TOOL_NAME) {
      throw new Error(`unsupported tool: ${call.function.name}`);
    }
    return readMermaidSyntaxes(JSON.parse(call.function.arguments), maxTools);
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
  const tools = [MERMAID_TOOL as unknown as Json];
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

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await provider.complete({ ...request, messages, tools });
    if (!response.toolCalls?.length) return merge(response);
    merge(response);
    messages.push({
      role: "assistant",
      content: response.text || null,
      tool_calls: response.toolCalls,
    });
    for (const call of response.toolCalls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: runTool(call, maxTools),
      });
    }
  }
  // ponytail: the model kept calling tools, so answer without them rather than
  // losing the whole job. Raise MAX_TOOL_ROUNDS if that truncates real work.
  return merge(await provider.complete({ ...request, messages }));
}
