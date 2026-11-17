/** The stdio MCP client against a fake server: start, list, call, timeout,
 * crash, and the server's environment. */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import {
  FAKE_MCP_ISSUE_TEXT,
  writeFakeMcpServer,
} from "../testing/fake_mcp_server.ts";
import { McpClient, McpError, McpRpcError, mcpEnv } from "./mcp_client.ts";
import type { McpServerConfig } from "./mcp_config.ts";

const scriptDir = tempDirSync();
const script = writeFakeMcpServer(scriptDir);
after(() => rmSync(scriptDir, { recursive: true, force: true }));

function server(extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    command: process.execPath,
    args: [script],
    tools: ["get_issue"],
    ...extra,
  };
}

test("start lists every tool across pages, past a line that is not JSON and a ping", async () => {
  const { client, tools } = await McpClient.start(server());
  try {
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "get_issue",
        "close_issue",
        "no_hint",
        "bad_schema",
        "slow",
        "crash",
        "env",
        "fail",
      ],
    );
    assert.equal(tools[1]?.annotations?.readOnlyHint, false);
    assert.ok(client.alive);
  } finally {
    await client.stop();
  }
  assert.equal(client.alive, false);
});

test("a call keeps the text and notes the parts that are not text", async () => {
  const { client } = await McpClient.start(server());
  try {
    const result = await client.call("get_issue", { id: "7" }, 5000);
    assert.equal(
      result.text,
      `${FAKE_MCP_ISSUE_TEXT}\n[1 part that is not text left out]`,
    );
    assert.equal(result.isError, false);
    const failed = await client.call("fail", {}, 5000);
    assert.deepEqual(failed, { text: "issue not found", isError: true });
    await assert.rejects(client.call("missing", {}, 5000), McpRpcError);
    // A JSON-RPC error leaves the server up.
    assert.ok(client.alive);
  } finally {
    await client.stop();
  }
});

test("a call that takes too long times out", async () => {
  const { client } = await McpClient.start(server());
  try {
    await assert.rejects(
      client.call("slow", {}, 200),
      (error: unknown) =>
        error instanceof McpError &&
        /did not answer tools\/call within/.test(error.message),
    );
  } finally {
    await client.stop();
  }
});

test("a server that exits during a call fails the call and every later one", async () => {
  const { client } = await McpClient.start(server());
  await assert.rejects(
    client.call("crash", {}, 5000),
    (error: unknown) =>
      error instanceof McpError && error.message === "exited with code 3",
  );
  assert.equal(client.alive, false);
  await assert.rejects(client.call("get_issue", {}, 5000), McpError);
  await client.stop();
});

test("a server that never answers initialize fails the start in time", async () => {
  const started = Date.now();
  await assert.rejects(
    McpClient.start(server({ args: [script, "--hang-start"] }), {
      timeoutMs: 300,
    }),
    (error: unknown) =>
      error instanceof McpError &&
      /did not answer initialize/.test(error.message),
  );
  assert.ok(Date.now() - started < 5000);
});

test("a server that exits at once, or a command that does not exist, fails the start", async () => {
  await assert.rejects(
    McpClient.start(server({ args: [script, "--exit-start"] })),
    (error: unknown) =>
      error instanceof McpError && error.message === "exited with code 2",
  );
  await assert.rejects(
    McpClient.start(server({ command: "/no/such/mcp-server" })),
    (error: unknown) =>
      error instanceof McpError && error.message.startsWith("could not be run"),
  );
});

test("the server gets its own env plus PATH and HOME, never co-maintainer's", async () => {
  const savedToken = getEnv("CO_MAINTAINER_TOKEN");
  setEnv("CO_MAINTAINER_TOKEN", "secret-test-token");
  try {
    const { client } = await McpClient.start(
      server({ env: { TRACKER_TOKEN: "abc" } }),
    );
    try {
      const names = (await client.call("env", {}, 5000)).text.split(",");
      assert.ok(names.includes("TRACKER_TOKEN"));
      assert.ok(names.includes("PATH"));
      assert.ok(!names.includes("CO_MAINTAINER_TOKEN"));
      assert.ok(!names.includes("CM_CONFIG_PATH"));
    } finally {
      await client.stop();
    }
  } finally {
    if (savedToken === undefined) deleteEnv("CO_MAINTAINER_TOKEN");
    else setEnv("CO_MAINTAINER_TOKEN", savedToken);
  }
  assert.deepEqual(Object.keys(mcpEnv({ A: "1" })).sort(), [
    "A",
    "HOME",
    "PATH",
  ]);
});
