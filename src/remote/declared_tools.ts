/** Tools a remote review client declares (issue 79).
 *
 * A client that finds the `client-tools` feature in the handshake sends each
 * tool's name, description and parameters in the submit's
 * `capabilities.tools`. An entry whose name the server knows (codegraph,
 * `search-non-code`) is one of the server's own tools, offered as before.
 * Any other entry is a declaration: a tool the client runs, today the tools
 * of the client's own MCP servers.
 *
 * The server's policy, `remoteClientToolsPolicy`, is `off` by default, and
 * then every declaration is ignored. With `on`, a declaration is offered
 * within the limits below, and each one left out gives a
 * `client_tools_refused` warning. Every result goes through the review's
 * tool gate like any other tool's, comes behind the outside-the-repository
 * line, and is private: the review removes a passage copied from it. */
import type { ToolHandler } from "../ai/mermaid_loop.ts";
import type { ClientToolsPolicy } from "../config.ts";
import type { CoverageWarning } from "../review/coverage.ts";
import { convertInputSchema, type McpSession } from "../tools/mcp_tools.ts";
import type { Json } from "../types.ts";
import { REMOTE_KNOWN_TOOL_NAMES } from "./schema.ts";
import { queueToolCall } from "./tool_bridge.ts";

/** The handshake feature that says the server reads declarations. */
export const CLIENT_TOOLS_FEATURE = "client-tools";
/** Most declared tools one review offers. */
export const MAX_CLIENT_TOOLS = 16;
/** Largest declaration, as JSON, in bytes. */
export const MAX_CLIENT_TOOL_DECLARATION_BYTES = 16 * 1024;
/** All declarations together, so 16 tools near the single limit cannot crowd
 * the review out of the model's context. */
export const MAX_CLIENT_TOOLS_TOTAL_BYTES = 64 * 1024;
/** What a declared tool may be called. */
export const CLIENT_TOOL_NAME = /^[a-z][a-z0-9-]{1,63}$/;
/** Most characters of one declared tool's result the server takes from the
 * client, before its gate. The gate's own cap is lower by default, and this
 * bounds a result when a repository turns that cap off. */
export const CLIENT_TOOL_RESULT_MAX_CHARS = 40_000;

/** The longest client-written description the model is shown. */
const MAX_DESCRIPTION_CHARS = 1000;

/** Built-in tool names outside the remote known list. */
const BUILT_IN = new Set([
  "search-non-code",
  "read-full-diff",
  "read-mermaid-syntaxes",
]);

/** True when `name` is, or could be, one of the server's own tools. */
export function shadowsBuiltInTool(name: string): boolean {
  return (
    BUILT_IN.has(name) ||
    REMOTE_KNOWN_TOOL_NAMES.has(name) ||
    name.startsWith("codegraph-") ||
    name.startsWith("mcp-")
  );
}

/** One declaration the server accepted. */
export type DeclaredTool = {
  name: string;
  description: string;
  parameters: Json;
};

/** True for a `capabilities.tools` entry that declares a client tool rather
 * than offering one of the server's known tools. */
export function isDeclaration(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const name = (entry as { name?: unknown }).name;
  return typeof name === "string" && !REMOTE_KNOWN_TOOL_NAMES.has(name);
}

function refused(message: string): CoverageWarning {
  return { code: "client_tools_refused", message };
}

/** A client-chosen name, safe to put in a warning. */
function shown(name: string): string {
  return JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}...` : name);
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** The declarations of one submit's `capabilities.tools` the server offers,
 * and a warning for each one it does not. */
export function declaredClientTools(
  entries: unknown,
  policy: ClientToolsPolicy,
): { tools: DeclaredTool[]; warnings: CoverageWarning[] } {
  const declarations = (Array.isArray(entries) ? entries : []).filter(
    isDeclaration,
  ) as Record<string, unknown>[];
  if (declarations.length === 0) return { tools: [], warnings: [] };
  if (policy === "off") {
    return {
      tools: [],
      warnings: [
        refused(
          `This server does not accept tools from the client, so ${declarations.length} declared ${
            declarations.length === 1 ? "tool was" : "tools were"
          } not offered.`,
        ),
      ],
    };
  }
  const tools: DeclaredTool[] = [];
  const warnings: CoverageWarning[] = [];
  const seen = new Set<string>();
  let over = 0;
  let total = 0;
  for (const entry of declarations) {
    const name = entry.name as string;
    const why = (() => {
      if (!CLIENT_TOOL_NAME.test(name)) {
        return "a name is 2 to 64 lowercase letters, digits or dashes and starts with a letter";
      }
      if (shadowsBuiltInTool(name)) {
        return "its name belongs to the server's own tools";
      }
      if (seen.has(name)) return "another client tool has the same name";
      if (bytes(entry) > MAX_CLIENT_TOOL_DECLARATION_BYTES) {
        return `its declaration is over ${MAX_CLIENT_TOOL_DECLARATION_BYTES / 1024} KB`;
      }
      if (
        entry.description !== undefined &&
        typeof entry.description !== "string"
      ) {
        return "its description is not text";
      }
      return undefined;
    })();
    if (why) {
      warnings.push(
        refused(`The client tool ${shown(name)} was not offered: ${why}.`),
      );
      continue;
    }
    const parameters =
      entry.parameters === undefined
        ? ({ type: "object", properties: {} } as Json)
        : convertInputSchema(entry.parameters);
    if (!parameters) {
      warnings.push(
        refused(
          `The client tool ${shown(name)} was not offered: its parameters are not an object schema.`,
        ),
      );
      continue;
    }
    seen.add(name);
    if (tools.length >= MAX_CLIENT_TOOLS) {
      over++;
      continue;
    }
    if (total + bytes(entry) > MAX_CLIENT_TOOLS_TOTAL_BYTES) {
      warnings.push(
        refused(
          `The client tool ${shown(name)} was not offered: the declared tools together are over ${MAX_CLIENT_TOOLS_TOTAL_BYTES / 1024} KB.`,
        ),
      );
      continue;
    }
    total += bytes(entry);
    const own =
      typeof entry.description === "string" ? entry.description.trim() : "";
    tools.push({
      name,
      description:
        `Read-only tool ${name} of the review client. Its results are private.${
          own ? ` ${own}` : ""
        }`.slice(0, MAX_DESCRIPTION_CHARS),
      parameters,
    });
  }
  if (over > 0) {
    warnings.push(
      refused(
        `This server offers at most ${MAX_CLIENT_TOOLS} client tools, so ${over} more ${
          over === 1 ? "was" : "were"
        } not offered.`,
      ),
    );
  }
  return { tools, warnings };
}

/** The declared tools of one review as a session of private tools. Each call
 * goes to the client over the bridge. Every result is kept for the
 * copied-passage check and never logged. */
export function clientToolSession(
  jobId: string,
  signal: AbortSignal,
  declared: { tools: DeclaredTool[]; warnings: CoverageWarning[] },
): McpSession {
  const results: string[] = [];
  const tools: ToolHandler[] = declared.tools.map((tool) => ({
    name: tool.name,
    external: true,
    private: true,
    tool: {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    },
    run: async (args) => {
      const output = await queueToolCall(
        jobId,
        signal,
        tool.name,
        args,
        CLIENT_TOOL_RESULT_MAX_CHARS,
      );
      results.push(output);
      return output;
    },
  }));
  return {
    tools,
    servers: [],
    warnings: () => [...declared.warnings],
    privateResults: () => [...results],
    stop: async () => {},
  };
}
