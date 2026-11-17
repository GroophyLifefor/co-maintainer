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

/** Waits for `work` and runs `beat` every `everyMs` until it settles. The
 * server cancels a review whose client sends no sync for its timeout, and a
 * slow tool batch would otherwise look like a client that went away. One
 * beat ends before the next starts, and no beat starts once `work` settled.
 * A beat that throws ends the wait with that error. */
export async function runWithHeartbeat<T>(
  work: Promise<T>,
  everyMs: number,
  beat: () => Promise<void>,
): Promise<T> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const finished = work.finally(() => {
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    wake?.();
  });
  const beating = (async () => {
    while (!settled) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, everyMs);
      });
      if (settled) return;
      await beat();
    }
  })();
  try {
    // A beat that fails ends the wait at once. Otherwise the batch decides.
    return await Promise.race([finished, beating.then(() => finished)]);
  } finally {
    // A beat still on the wire is waited for, so what it brought back is
    // handled before the batch's results are sent.
    await beating.catch(() => {});
  }
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
