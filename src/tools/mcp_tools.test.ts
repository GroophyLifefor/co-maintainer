/** A repository's MCP servers as review tools: which listed tools are
 * offered, the warnings for the rest, private results, and a server that
 * fails at start or later. */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { tempDirSync } from "../testing/runtime.ts";
import {
  FAKE_MCP_ISSUE_TEXT,
  writeFakeMcpServer,
} from "../testing/fake_mcp_server.ts";
import type { McpServerConfig } from "./mcp_config.ts";
import {
  MAX_MCP_SCHEMA_BYTES,
  MAX_MCP_TOOLS_BYTES,
  convertInputSchema,
  emptyMcpSession,
  startMcpSession,
} from "./mcp_tools.ts";

const scriptDir = tempDirSync();
const script = writeFakeMcpServer(scriptDir);
after(() => rmSync(scriptDir, { recursive: true, force: true }));

function server(
  tools: string[],
  extra: Partial<McpServerConfig> = {},
): McpServerConfig {
  return { command: process.execPath, args: [script], tools, ...extra };
}

const codes = (session: { warnings(): { code: string }[] }) =>
  session.warnings().map((warning) => warning.code);

test("only listed read-only tools are offered, as mcp-<server>-<tool>", async () => {
  const session = await startMcpSession({
    tracker: server([
      "get_issue",
      "close_issue",
      "no_hint",
      "bad_schema",
      "absent",
    ]),
  });
  try {
    assert.deepEqual(
      session.tools.map((tool) => tool.name),
      ["mcp-tracker-get_issue", "mcp-tracker-no_hint"],
    );
    assert.ok(session.tools.every((tool) => tool.external === true));
    assert.deepEqual(session.servers, ["tracker"]);
    assert.deepEqual(codes(session), [
      "mcp_tool_refused",
      "mcp_tool_refused",
      "mcp_tool_missing",
    ]);
    const messages = session.warnings().map((warning) => warning.message);
    assert.ok(messages[0]?.includes("close_issue as not read-only"));
    assert.ok(messages[1]?.includes("bad_schema"));
    assert.ok(messages[2]?.includes("no tool named absent"));
    // A tool that is not listed is never offered, even a read-only one.
    assert.ok(!session.tools.some((tool) => tool.name.endsWith("-env")));
    const fn = (session.tools[0]!.tool as { function: Record<string, unknown> })
      .function;
    assert.deepEqual(fn.parameters, {
      type: "object",
      properties: { id: { type: "string" } },
    });
  } finally {
    await session.stop();
  }
});

test("a schema over 16 KB is refused and the definitions stop at 64 KB per review", async () => {
  assert.equal(MAX_MCP_SCHEMA_BYTES, 16 * 1024);
  assert.equal(MAX_MCP_TOOLS_BYTES, 64 * 1024);
  const session = await startMcpSession({
    tracker: server(
      ["big_schema", "wide_1", "wide_2", "wide_3", "wide_4", "wide_5"],
      { env: { FAKE_MCP_BIG_TOOLS: "1" } },
    ),
  });
  try {
    assert.deepEqual(
      session.tools.map((tool) => tool.name),
      [
        "mcp-tracker-wide_1",
        "mcp-tracker-wide_2",
        "mcp-tracker-wide_3",
        "mcp-tracker-wide_4",
      ],
    );
    const total = session.tools.reduce(
      (sum, tool) => sum + JSON.stringify(tool.tool).length,
      0,
    );
    assert.ok(total <= MAX_MCP_TOOLS_BYTES);
    assert.deepEqual(codes(session), ["mcp_tool_refused", "mcp_tool_refused"]);
    assert.deepEqual(
      session.warnings().map((warning) => warning.message),
      [
        "The tool big_schema of the MCP server tracker has an input schema over 16 KB, so it was not offered.",
        "The tool wide_5 of the MCP server tracker would take the MCP tool definitions of this review over 64 KB, so it was not offered.",
      ],
    );
  } finally {
    await session.stop();
  }
});

test("every result is kept as private, and a server error is answered as text", async () => {
  const session = await startMcpSession({
    tracker: server(["get_issue", "fail", "no_hint"]),
  });
  try {
    const [issue, fail, ok] = session.tools;
    assert.equal(
      await issue!.run({ id: "1" }),
      `${FAKE_MCP_ISSUE_TEXT}\n[1 part that is not text left out]`,
    );
    assert.equal(
      await fail!.run({}),
      "The tool answered with an error:\nissue not found",
    );
    assert.equal(await ok!.run({}), "ok");
    assert.deepEqual(session.privateResults(), [
      `${FAKE_MCP_ISSUE_TEXT}\n[1 part that is not text left out]`,
      "issue not found",
      "ok",
    ]);
  } finally {
    await session.stop();
  }
});

test("a server that does not start warns mcp_unavailable and the others still run", async () => {
  const session = await startMcpSession(
    {
      broken: server(["get_issue"], { args: [script, "--hang-start"] }),
      tracker: server(["get_issue"]),
    },
    { startupMs: 300 },
  );
  try {
    assert.deepEqual(session.servers, ["tracker"]);
    assert.deepEqual(
      session.tools.map((tool) => tool.name),
      ["mcp-tracker-get_issue"],
    );
    assert.deepEqual(codes(session), ["mcp_unavailable"]);
    assert.match(
      session.warnings()[0]!.message,
      /^The MCP server broken did not start \(did not answer initialize within 0\.3 seconds\), so the review went on without it\.$/,
    );
  } finally {
    await session.stop();
  }
});

test("a server that stops answering warns once and later calls get a fixed answer", async () => {
  const session = await startMcpSession({
    tracker: server(["slow", "get_issue"], { timeoutSeconds: 0.3 }),
  });
  try {
    const [slow, issue] = session.tools;
    assert.equal(
      await slow!.run({}),
      "The MCP server tracker stopped answering. Answer without it.",
    );
    assert.equal(
      await issue!.run({}),
      "The MCP server tracker is not available. Answer without it.",
    );
    assert.deepEqual(codes(session), ["mcp_unavailable"]);
    assert.deepEqual(session.privateResults(), []);
  } finally {
    await session.stop();
  }
});

test("stop ends every server and may be called twice", async () => {
  const session = await startMcpSession({ tracker: server(["get_issue"]) });
  await session.stop();
  await session.stop();
  assert.equal(
    await session.tools[0]!.run({}),
    "The MCP server tracker is not available. Answer without it.",
  );
  await emptyMcpSession().stop();
});

test("an input schema converts only when it is an object schema", () => {
  assert.deepEqual(
    convertInputSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    }),
    { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  );
  assert.equal(convertInputSchema({ type: "string" }), undefined);
  assert.equal(convertInputSchema(undefined), undefined);
  assert.equal(convertInputSchema([]), undefined);
  assert.equal(
    convertInputSchema({ type: "object", properties: [] }),
    undefined,
  );
});
