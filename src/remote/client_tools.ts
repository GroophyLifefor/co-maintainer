import type { ToolHandler } from "../ai/mermaid_loop.ts";

export type RemoteToolCall = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type RemoteToolResult = {
  callId: string;
  output?: string;
  error?: string;
};

export function toolHandlerMap(
  handlers: ToolHandler[],
): Map<string, ToolHandler> {
  return new Map(handlers.map((handler) => [handler.name, handler]));
}

export async function runRemoteToolCalls(
  calls: RemoteToolCall[],
  handlers: Map<string, ToolHandler>,
): Promise<RemoteToolResult[]> {
  const results: RemoteToolResult[] = [];
  for (const call of calls) {
    const handler = handlers.get(call.name);
    if (!handler) {
      results.push({
        callId: call.callId,
        error: `unknown tool: ${call.name}`,
      });
      continue;
    }
    try {
      const output = await handler.run(call.arguments);
      results.push({
        callId: call.callId,
        output: typeof output === "string" ? output : String(output),
      });
    } catch (error) {
      results.push({
        callId: call.callId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
