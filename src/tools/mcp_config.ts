/** A repository's MCP servers (issue 79): the file `set --mcp-config` reads,
 * and the switch that turns MCP off on a machine.
 *
 * The file is read once and stored as `repos["owner/repo"].mcpServers` in
 * `config.json`, so a review never reads a path that may have moved. `env`
 * values are secrets for the server, so nothing here prints them. */
import { getEnv } from "../util/runtime.ts";

/** One stdio MCP server, as `config.json` stores it. */
export type McpServerConfig = {
  command: string;
  args?: string[];
  /** The server's whole environment, with `PATH` and `HOME` added. */
  env?: Record<string, string>;
  /** The only tools offered to the model, by the server's own names. */
  tools: string[];
  /** Seconds one call may take. Unset means 20. */
  timeoutSeconds?: number;
};

/** Seconds one tool call may take when the config sets none. */
export const DEFAULT_MCP_TIMEOUT_SECONDS = 20;

/** `CM_MCP_DISABLED=1` turns MCP off hard. The hosted cloud sets it from
 * outside the container, so nothing in the user's data volume can turn it
 * back on. */
export function mcpDisabled(): boolean {
  return getEnv("CM_MCP_DISABLED") === "1";
}

export const MCP_DISABLED_MESSAGE =
  "MCP servers are turned off on this machine (CM_MCP_DISABLED=1).";

/** A server name becomes part of the tool name `mcp-<server>-<tool>`, which
 * every provider limits to letters, digits, dashes and underscores. A dash
 * in the server name would make two names read the same, so it has none. */
const SERVER_NAME = /^[A-Za-z0-9_]{1,32}$/;

const SERVER_KEYS = new Set([
  "command",
  "args",
  "env",
  "tools",
  "timeoutSeconds",
  "type",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Thrown with a message that names what is wrong in the file. */
export class McpConfigError extends Error {}

function fail(message: string): never {
  throw new McpConfigError(message);
}

function server(name: string, raw: unknown): McpServerConfig {
  if (!SERVER_NAME.test(name)) {
    fail(
      `The server name "${name}" must be 1 to 32 letters, digits or underscores.`,
    );
  }
  if (!isRecord(raw)) fail(`Server ${name} must be an object.`);
  for (const key of Object.keys(raw)) {
    if (!SERVER_KEYS.has(key)) {
      fail(
        key === "url"
          ? `Server ${name} has a url. Only stdio servers started with a command are supported.`
          : `Server ${name} has an unknown key "${key}". Known keys: command, args, env, tools, timeoutSeconds.`,
      );
    }
  }
  if (raw.type !== undefined && raw.type !== "stdio") {
    fail(
      `Server ${name} has type "${String(raw.type)}". Only stdio is supported.`,
    );
  }
  if (typeof raw.command !== "string" || raw.command.trim() === "") {
    fail(`Server ${name} needs a command.`);
  }
  const config: McpServerConfig = { command: raw.command, tools: [] };
  if (raw.args !== undefined) {
    if (
      !Array.isArray(raw.args) ||
      raw.args.some((arg) => typeof arg !== "string")
    ) {
      fail(`Server ${name}: args must be a list of strings.`);
    }
    config.args = raw.args as string[];
  }
  if (raw.env !== undefined) {
    if (
      !isRecord(raw.env) ||
      Object.values(raw.env).some((value) => typeof value !== "string")
    ) {
      fail(`Server ${name}: env must map names to string values.`);
    }
    config.env = { ...(raw.env as Record<string, string>) };
  }
  if (
    !Array.isArray(raw.tools) ||
    raw.tools.length === 0 ||
    raw.tools.some((tool) => typeof tool !== "string" || tool.trim() === "")
  ) {
    fail(
      `Server ${name} needs tools: a list of the read-only tool names to offer.`,
    );
  }
  config.tools = [...new Set(raw.tools as string[])];
  if (raw.timeoutSeconds !== undefined) {
    const seconds = raw.timeoutSeconds;
    if (typeof seconds !== "number" || !(seconds > 0) || seconds > 600) {
      fail(
        `Server ${name}: timeoutSeconds must be a number above 0 and at most 600.`,
      );
    }
    config.timeoutSeconds = seconds;
  }
  return config;
}

/** The servers in an `mcp.json` file's text. */
export function parseMcpConfig(text: string): Record<string, McpServerConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("The MCP config is not valid JSON.");
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    fail('The MCP config needs an "mcpServers" object.');
  }
  const entries = Object.entries(parsed.mcpServers);
  if (entries.length === 0) {
    fail(
      "The MCP config has no servers. Use --unset=mcp-config to remove them.",
    );
  }
  return Object.fromEntries(
    entries.map(([name, raw]) => [name, server(name, raw)]),
  );
}

/** `tracker (get_issue, search_issues)`: what `set` prints. Never the
 * command, its arguments or its env, which may hold secrets. */
export function mcpServersSummary(
  servers: Record<string, McpServerConfig>,
): string {
  return Object.entries(servers)
    .map(([name, config]) => `${name} (${config.tools.join(", ")})`)
    .join(", ");
}
