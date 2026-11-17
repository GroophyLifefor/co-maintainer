import type { ToolHandler } from "../ai/mermaid_loop.ts";
import type { CoverageWarning } from "../review/coverage.ts";
import type { McpServerConfig } from "../tools/mcp_config.ts";
import { CLIENT_TOOL_NAME, shadowsBuiltInTool } from "./declared_tools.ts";
import { REMOTE_KNOWN_TOOL_NAMES } from "./schema.ts";

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

/** The name a client MCP tool is declared under: `mcp-<server>-<tool>`
 * becomes `client-<server>-<tool>` in lowercase, with any other character a
 * dash, so it fits the server's name rule and never takes the name of the
 * server's own MCP tools. */
export function declaredToolName(mcpName: string): string {
  return `client-${mcpName.replace(/^mcp-/, "")}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
}

function refused(message: string): CoverageWarning {
  return { code: "client_tools_refused", message };
}

/** The client's own MCP tools under their declared names. A tool whose name
 * cannot be declared is left out with a `client_tools_refused` warning. */
export function declareClientMcpTools(tools: ToolHandler[]): {
  tools: ToolHandler[];
  warnings: CoverageWarning[];
} {
  const declared: ToolHandler[] = [];
  const warnings: CoverageWarning[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = declaredToolName(tool.name);
    if (!CLIENT_TOOL_NAME.test(name) || shadowsBuiltInTool(name)) {
      warnings.push(
        refused(
          `The MCP tool ${tool.name} cannot be sent to the server as ${name}, so it was not declared.`,
        ),
      );
      continue;
    }
    if (seen.has(name)) {
      warnings.push(
        refused(
          `The MCP tool ${tool.name} has the same declared name as another, ${name}, so it was not declared.`,
        ),
      );
      continue;
    }
    seen.add(name);
    const fn = (tool.tool as { function?: Record<string, unknown> }).function;
    declared.push({
      ...tool,
      name,
      tool: { type: "function", function: { ...fn, name } },
    });
  }
  return { tools: declared, warnings };
}

/** What the submit's `capabilities.tools` says about the client's tools. A
 * server with the `client-tools` feature gets each tool's name, description
 * and parameters, the declared ones included. An older server gets the names
 * of its known tools only, as before. */
export function capabilityTools(
  tools: ToolHandler[],
  declared: ReadonlySet<string>,
  withSchemas: boolean,
): Array<{ name: string; description?: unknown; parameters?: unknown }> {
  if (!withSchemas) {
    return tools
      .filter((tool) => REMOTE_KNOWN_TOOL_NAMES.has(tool.name))
      .map((tool) => ({ name: tool.name }));
  }
  return tools
    .filter(
      (tool) =>
        REMOTE_KNOWN_TOOL_NAMES.has(tool.name) || declared.has(tool.name),
    )
    .map((tool) => {
      const fn = (tool.tool as { function?: Record<string, unknown> }).function;
      return {
        name: tool.name,
        ...(fn?.description === undefined
          ? {}
          : { description: fn.description }),
        ...(fn?.parameters === undefined ? {} : { parameters: fn.parameters }),
      };
    });
}

/** Why the client's own MCP servers sit out this remote review, or
 * `undefined` when they take part. */
export function clientToolsRefusal(
  servers: Record<string, McpServerConfig> | undefined,
  server: { version: string; feature: boolean; policy: unknown },
): CoverageWarning | undefined {
  if (!servers || Object.keys(servers).length === 0) return undefined;
  if (!server.feature) {
    return refused(
      `This server (version ${server.version}) does not take tools from the client, so your MCP servers were not used.`,
    );
  }
  if (server.policy !== "on") {
    return refused(
      "This server does not accept tools from the client, so your MCP servers were not used.",
    );
  }
  return undefined;
}
