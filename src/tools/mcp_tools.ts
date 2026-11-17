/** A repository's MCP servers as review tools (issue 79).
 *
 * The servers start once per review, before the first model call, and stop
 * however the review ends. Each listed tool the server has and does not mark
 * as writing is offered as `mcp-<server>-<tool>`. A server that does not
 * start, or stops answering, gives `mcp_unavailable` and the review goes on
 * without it.
 *
 * Every result is private. The session keeps each one, so the review can
 * remove a copied passage from what it prints, posts and stores. A result is
 * never logged. */
import type { ToolHandler } from "../ai/mermaid_loop.ts";
import type { CoverageWarning } from "../review/coverage.ts";
import type { Json } from "../types.ts";
import { log } from "../util/log.ts";
import { McpClient, McpError, type McpTool, type Spawn } from "./mcp_client.ts";
import {
  DEFAULT_MCP_TIMEOUT_SECONDS,
  type McpServerConfig,
} from "./mcp_config.ts";

/** One review's MCP servers and the tools they give. */
export type McpSession = {
  tools: ToolHandler[];
  /** The servers that started, in config order, for the Metadata line. */
  servers: string[];
  warnings(): CoverageWarning[];
  /** Every result the model received from an MCP tool in this review. */
  privateResults(): string[];
  /** Stops every server. Never throws, and a second call does nothing. */
  stop(): Promise<void>;
};

export function emptyMcpSession(): McpSession {
  return {
    tools: [],
    servers: [],
    warnings: () => [],
    privateResults: () => [],
    stop: async () => {},
  };
}

/** Tool names every provider accepts. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The longest server-written tool description the model is shown. */
const MAX_DESCRIPTION_CHARS = 1000;

export function mcpToolName(server: string, tool: string): string {
  return `mcp-${server}-${tool}`;
}

export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp-");
}

/** The tool's input schema in the provider's function format, or
 * `undefined` when it cannot be sent. MCP requires an object schema. */
export function convertInputSchema(schema: unknown): Json | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
  if (rest.type !== "object") return undefined;
  if (
    rest.properties !== undefined &&
    (typeof rest.properties !== "object" ||
      rest.properties === null ||
      Array.isArray(rest.properties))
  ) {
    return undefined;
  }
  try {
    // A schema that cannot round-trip through JSON cannot be sent.
    return JSON.parse(JSON.stringify(rest)) as Json;
  } catch {
    return undefined;
  }
}

export type McpSessionDeps = {
  spawn?: Spawn;
  startupMs?: number;
};

type Started = {
  name: string;
  config: McpServerConfig;
  client: McpClient;
  tools: McpTool[];
};

/** Starts every server at once and builds the tools. */
export async function startMcpSession(
  servers: Record<string, McpServerConfig>,
  deps: McpSessionDeps = {},
): Promise<McpSession> {
  const warnings: CoverageWarning[] = [];
  const results: string[] = [];
  const down = new Set<string>();
  const unavailable = (server: string, why: string) => {
    if (down.has(server)) return;
    down.add(server);
    warnings.push({
      code: "mcp_unavailable",
      message: `The MCP server ${server} ${why}, so the review went on without it.`,
    });
  };

  const settled = await Promise.all(
    Object.entries(servers).map(
      async ([name, config]): Promise<Started | undefined> => {
        try {
          const { client, tools } = await McpClient.start(config, {
            timeoutMs: deps.startupMs,
            spawn: deps.spawn,
          });
          log("mcp", `${name} started · ${tools.length} tool(s) listed`);
          return { name, config, client, tools };
        } catch (error) {
          const reason =
            error instanceof McpError ? error.message : String(error);
          log("mcp", `${name} did not start · ${reason}`);
          unavailable(name, `did not start (${reason})`);
          return undefined;
        }
      },
    ),
  );
  const started = settled.filter((item): item is Started => !!item);

  const tools: ToolHandler[] = [];
  for (const { name: server, config, client, tools: listed } of started) {
    const timeoutMs =
      (config.timeoutSeconds ?? DEFAULT_MCP_TIMEOUT_SECONDS) * 1000;
    for (const wanted of config.tools) {
      const tool = listed.find((item) => item.name === wanted);
      if (!tool) {
        warnings.push({
          code: "mcp_tool_missing",
          message: `The MCP server ${server} has no tool named ${wanted}, so it was not offered.`,
        });
        continue;
      }
      if (tool.annotations?.readOnlyHint === false) {
        warnings.push({
          code: "mcp_tool_refused",
          message: `The MCP server ${server} marks ${wanted} as not read-only, so it was not offered.`,
        });
        continue;
      }
      const name = mcpToolName(server, wanted);
      const parameters = convertInputSchema(tool.inputSchema);
      if (!TOOL_NAME.test(name) || !parameters) {
        warnings.push({
          code: "mcp_tool_refused",
          message: `The tool ${wanted} of the MCP server ${server} cannot be sent to the model as ${name}, so it was not offered.`,
        });
        continue;
      }
      const own =
        typeof tool.description === "string" ? tool.description.trim() : "";
      tools.push({
        name,
        external: true,
        tool: {
          type: "function",
          function: {
            name,
            description:
              `Read-only tool ${wanted} of the repository's MCP server ${server}. Its results are private.${
                own ? ` ${own}` : ""
              }`.slice(0, MAX_DESCRIPTION_CHARS),
            parameters,
          },
        },
        run: async (args) => {
          if (!client.alive || down.has(server)) {
            return `The MCP server ${server} is not available. Answer without it.`;
          }
          try {
            const result = await client.call(wanted, args, timeoutMs);
            results.push(result.text);
            return result.isError
              ? `The tool answered with an error:\n${result.text}`
              : result.text;
          } catch (error) {
            if (error instanceof McpError) {
              log("mcp", `${server} stopped answering · ${error.message}`);
              unavailable(server, `stopped answering (${error.message})`);
              void client.stop();
              return `The MCP server ${server} stopped answering. Answer without it.`;
            }
            // A JSON-RPC error: the server is still up.
            return `The MCP server ${server} could not run ${wanted}: ${
              error instanceof Error ? error.message : String(error)
            }.`;
          }
        },
      });
    }
  }

  let stopped: Promise<void> | undefined;
  return {
    tools,
    servers: started.map((item) => item.name),
    warnings: () => [...warnings],
    privateResults: () => [...results],
    stop: () =>
      (stopped ??= Promise.all(started.map((item) => item.client.stop())).then(
        () => {},
      )),
  };
}
