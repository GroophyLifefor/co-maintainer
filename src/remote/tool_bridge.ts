import type { ToolHandler } from "../ai/mermaid_loop.ts";
import { readConfig } from "../config.ts";
import { REMOTE_KNOWN_TOOL_NAMES } from "./schema.ts";

export type PendingToolCall = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

type PendingEntry = {
  resolve: (output: string) => void;
  reject: (err: Error) => void;
};

const pendingByJob = new Map<string, Map<string, PendingEntry>>();
const queuedCallsByJob = new Map<string, PendingToolCall[]>();

export function clearRemoteToolBridge(jobId: string): void {
  const pending = pendingByJob.get(jobId);
  if (pending) {
    for (const [, entry] of pending) {
      entry.reject(new Error("review ended"));
    }
  }
  pendingByJob.delete(jobId);
  queuedCallsByJob.delete(jobId);
}

export function drainPendingToolCalls(jobId: string): PendingToolCall[] {
  const queue = queuedCallsByJob.get(jobId) ?? [];
  queuedCallsByJob.set(jobId, []);
  return queue;
}

export function applyToolResults(
  jobId: string,
  results: Array<{ callId: string; output?: string; error?: string }>,
): void {
  const pending = pendingByJob.get(jobId);
  if (!pending) return;
  const maxChars = readConfig().remoteToolOutputMaxChars ?? 500_000;
  for (const row of results) {
    const entry = pending.get(row.callId);
    if (!entry) continue;
    pending.delete(row.callId);
    if (row.error !== undefined) {
      entry.reject(new Error(row.error));
      continue;
    }
    const out = row.output ?? "";
    entry.resolve(
      out.length > maxChars
        ? `${out.slice(0, maxChars)}\n...[truncated]`
        : out,
    );
  }
}

function queueToolCall(
  jobId: string,
  signal: AbortSignal,
  name: string,
  args: unknown,
): Promise<string> {
  if (signal.aborted) throw new Error("aborted");
  const callId = crypto.randomUUID();
  const argsObj =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const call: PendingToolCall = { callId, name, arguments: argsObj };
  let queue = queuedCallsByJob.get(jobId);
  if (!queue) {
    queue = [];
    queuedCallsByJob.set(jobId, queue);
  }
  queue.push(call);

  return new Promise((resolve, reject) => {
    let pending = pendingByJob.get(jobId);
    if (!pending) {
      pending = new Map();
      pendingByJob.set(jobId, pending);
    }
    pending.set(callId, { resolve, reject });
    const onAbort = () => {
      pending!.delete(callId);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Server-side handlers: same schemas as local tools, execution on the CLI. */
export function remoteBridgeToolHandlers(
  jobId: string,
  signal: AbortSignal,
  allowedNames: ReadonlySet<string>,
  sourceHandlers: ToolHandler[],
): ToolHandler[] {
  const byName = new Map(sourceHandlers.map((handler) => [handler.name, handler]));
  const handlers: ToolHandler[] = [];
  for (const name of allowedNames) {
    if (name === "read-full-diff" || !REMOTE_KNOWN_TOOL_NAMES.has(name)) {
      continue;
    }
    const src = byName.get(name);
    if (!src) continue;
    handlers.push({
      name: src.name,
      tool: src.tool,
      run: (args) => queueToolCall(jobId, signal, src.name, args),
    });
  }
  return handlers;
}
