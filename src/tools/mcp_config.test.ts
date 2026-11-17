/** The `mcp.json` file `set --mcp-config` reads, and the off switch. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteEnv, getEnv, setEnv } from "../testing/runtime.ts";
import {
  McpConfigError,
  mcpDisabled,
  mcpServersSummary,
  parseMcpConfig,
} from "./mcp_config.ts";

const valid = {
  mcpServers: {
    tracker: {
      command: "node",
      args: ["/opt/tracker-mcp/server.js"],
      env: { TRACKER_TOKEN: "secret" },
      tools: ["get_issue", "search_issues", "get_issue"],
      timeoutSeconds: 20,
    },
  },
};

test("a valid file gives its servers, each tool once", () => {
  assert.deepEqual(parseMcpConfig(JSON.stringify(valid)), {
    tracker: {
      command: "node",
      args: ["/opt/tracker-mcp/server.js"],
      env: { TRACKER_TOKEN: "secret" },
      tools: ["get_issue", "search_issues"],
      timeoutSeconds: 20,
    },
  });
});

function refused(value: unknown, pattern: RegExp): void {
  assert.throws(
    () =>
      parseMcpConfig(typeof value === "string" ? value : JSON.stringify(value)),
    (error: unknown) =>
      error instanceof McpConfigError && pattern.test(error.message),
  );
}

const server = (extra: Record<string, unknown>) => ({
  mcpServers: { tracker: { command: "node", tools: ["a"], ...extra } },
});

test("tools is required and every problem is named", () => {
  refused("{", /not valid JSON/);
  refused({}, /needs an "mcpServers" object/);
  refused({ mcpServers: {} }, /has no servers/);
  refused(
    { mcpServers: { "my-tracker": { command: "node", tools: ["a"] } } },
    /letters, digits or underscores/,
  );
  refused({ mcpServers: { tracker: { command: "node" } } }, /needs tools/);
  refused(server({ tools: [] }), /needs tools/);
  refused(server({ command: "" }), /needs a command/);
  refused(server({ args: "x" }), /args must be a list/);
  refused(server({ env: { A: 1 } }), /env must map/);
  refused(server({ timeoutSeconds: 0 }), /timeoutSeconds/);
  refused(server({ url: "https://example.com/mcp" }), /Only stdio servers/);
  refused(server({ type: "http" }), /Only stdio/);
  refused(server({ cwd: "/tmp" }), /unknown key "cwd"/);
  assert.ok(parseMcpConfig(JSON.stringify(server({ type: "stdio" }))).tracker);
});

test("the summary names servers and tools, never the command or env", () => {
  const summary = mcpServersSummary(parseMcpConfig(JSON.stringify(valid)));
  assert.equal(summary, "tracker (get_issue, search_issues)");
  assert.ok(!summary.includes("secret"));
});

test("CM_MCP_DISABLED=1, exactly, turns MCP off", () => {
  const saved = getEnv("CM_MCP_DISABLED");
  try {
    setEnv("CM_MCP_DISABLED", "1");
    assert.equal(mcpDisabled(), true);
    setEnv("CM_MCP_DISABLED", "true");
    assert.equal(mcpDisabled(), false);
    deleteEnv("CM_MCP_DISABLED");
    assert.equal(mcpDisabled(), false);
  } finally {
    if (saved === undefined) deleteEnv("CM_MCP_DISABLED");
    else setEnv("CM_MCP_DISABLED", saved);
  }
});
