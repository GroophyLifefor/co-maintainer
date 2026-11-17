/** A remote client's declared tools on the server (issue 79): the policy,
 * the limits, and the bridge that runs them on the client. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { remoteClientToolsPolicy } from "../config.ts";
import { deleteEnv, getEnv, setEnv } from "../util/runtime.ts";
import { privateToolsGuidance } from "../review/private_text.ts";
import { joinMcpSessions, emptyMcpSession } from "../tools/mcp_tools.ts";
import {
  clientToolSession,
  CLIENT_TOOL_RESULT_MAX_CHARS,
  declaredClientTools,
  MAX_CLIENT_TOOL_DECLARATION_BYTES,
  MAX_CLIENT_TOOLS,
  MAX_CLIENT_TOOLS_TOTAL_BYTES,
  shadowsBuiltInTool,
} from "./declared_tools.ts";
import {
  applyToolResults,
  clearRemoteToolBridge,
  drainPendingToolCalls,
} from "./tool_bridge.ts";
import { isolateTestFile } from "../testing/locations.ts";

// The bridge reads the server's config. Keep it in a temp home.
isolateTestFile();

const object = { type: "object", properties: { id: { type: "string" } } };

function declaration(name: string, extra: Record<string, unknown> = {}) {
  return { name, description: "Read one issue.", parameters: object, ...extra };
}

function codes(warnings: { code: string }[]): string[] {
  return warnings.map((warning) => warning.code);
}

test("with the policy on, a declaration is offered with its description and parameters", () => {
  const { tools, warnings } = declaredClientTools(
    [
      { name: "codegraph-query" },
      { name: "search-non-code", description: "x", parameters: object },
      declaration("client-tracker-get-issue"),
    ],
    "on",
  );
  assert.deepEqual(warnings, []);
  assert.equal(tools.length, 1, "the known tools are not declarations");
  assert.equal(tools[0]!.name, "client-tracker-get-issue");
  assert.deepEqual(tools[0]!.parameters, object);
  assert.match(
    tools[0]!.description,
    /Its results are private\. Read one issue\.$/,
  );
});

test("with the policy off, every declaration is ignored with one client_tools_refused", () => {
  const off = declaredClientTools(
    [
      declaration("client-a"),
      declaration("client-b"),
      { name: "codegraph-query" },
    ],
    "off",
  );
  assert.deepEqual(off.tools, []);
  assert.deepEqual(codes(off.warnings), ["client_tools_refused"]);
  assert.match(off.warnings[0]!.message, /2 declared tools were not offered/);
  // Nothing declared, nothing said, whatever the policy.
  assert.deepEqual(declaredClientTools([{ name: "codegraph-query" }], "off"), {
    tools: [],
    warnings: [],
  });
  assert.deepEqual(declaredClientTools(undefined, "on"), {
    tools: [],
    warnings: [],
  });
});

test("a bad, too long, shadowing, duplicate, too large or schema-less declaration is refused by name", () => {
  const long = `a${"b".repeat(64)}`;
  const { tools, warnings } = declaredClientTools(
    [
      declaration("Client-Upper"),
      declaration("x"),
      declaration(long),
      declaration("mcp-tracker-get_issue"),
      declaration("mcp-tracker-get-issue"),
      declaration("codegraph-anything"),
      // A known remote tool name: one of the server's own, not a declaration.
      declaration("read-full-diff"),
      declaration("read-mermaid-syntaxes"),
      declaration("client-ok"),
      declaration("client-ok"),
      declaration("client-big", { description: "y".repeat(17 * 1024) }),
      declaration("client-string", { parameters: { type: "string" } }),
      declaration("client-describe", { description: 7 }),
      declaration("client-no-params", { parameters: undefined }),
    ],
    "on",
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["client-ok", "client-no-params"],
  );
  assert.deepEqual(tools[1]!.parameters, { type: "object", properties: {} });
  assert.equal(warnings.length, 11);
  assert.ok(
    !warnings.some((warning) => warning.message.includes("read-full-diff")),
  );
  assert.ok(codes(warnings).every((code) => code === "client_tools_refused"));
  const text = warnings.map((warning) => warning.message).join("\n");
  assert.match(text, /"Client-Upper" was not offered: a name is 2 to 64/);
  assert.match(text, /"x" was not offered: a name/);
  assert.ok(text.includes(`"${long.slice(0, 80)}" was not offered: a name`));
  assert.match(
    text,
    /"mcp-tracker-get-issue" was not offered: its name belongs to the server's own tools/,
  );
  assert.match(text, /"codegraph-anything" was not offered: its name belongs/);
  assert.match(
    text,
    /"client-ok" was not offered: another client tool has the same name/,
  );
  assert.match(
    text,
    /"client-big" was not offered: its declaration is over 16 KB/,
  );
  assert.match(
    text,
    /"client-string" was not offered: its parameters are not an object schema/,
  );
  assert.match(
    text,
    /"client-describe" was not offered: its description is not text/,
  );
});

test(`at most ${MAX_CLIENT_TOOLS} declarations are offered, and the rest are counted in one warning`, () => {
  const many = Array.from({ length: MAX_CLIENT_TOOLS + 3 }, (_, i) =>
    declaration(`client-tool-${i}`),
  );
  const { tools, warnings } = declaredClientTools(many, "on");
  assert.equal(tools.length, MAX_CLIENT_TOOLS);
  assert.deepEqual(codes(warnings), ["client_tools_refused"]);
  assert.match(
    warnings[0]!.message,
    /at most 16 client tools, so 3 more were not offered/,
  );
});

test("the built-in names a declaration may not take", () => {
  for (const name of [
    "codegraph-query",
    "codegraph-new-one",
    "search-non-code",
    "read-full-diff",
    "read-mermaid-syntaxes",
    "mcp-tracker-get-issue",
  ]) {
    assert.ok(shadowsBuiltInTool(name), name);
  }
  assert.ok(!shadowsBuiltInTool("client-tracker-get-issue"));
});

test("the policy is off unless set, and the environment wins over the config", () => {
  const before = getEnv("CM_REMOTE_CLIENT_TOOLS_POLICY");
  try {
    deleteEnv("CM_REMOTE_CLIENT_TOOLS_POLICY");
    assert.equal(remoteClientToolsPolicy({}), "off");
    assert.equal(
      remoteClientToolsPolicy({ remoteClientToolsPolicy: "on" }),
      "on",
    );
    setEnv("CM_REMOTE_CLIENT_TOOLS_POLICY", "off");
    assert.equal(
      remoteClientToolsPolicy({ remoteClientToolsPolicy: "on" }),
      "off",
    );
    setEnv("CM_REMOTE_CLIENT_TOOLS_POLICY", "on");
    assert.equal(remoteClientToolsPolicy({}), "on");
    // A typo is unreadable and falls back to the config.
    setEnv("CM_REMOTE_CLIENT_TOOLS_POLICY", "yes");
    assert.equal(
      remoteClientToolsPolicy({ remoteClientToolsPolicy: "on" }),
      "on",
    );
    assert.equal(remoteClientToolsPolicy({}), "off");
  } finally {
    if (before === undefined) deleteEnv("CM_REMOTE_CLIENT_TOOLS_POLICY");
    else setEnv("CM_REMOTE_CLIENT_TOOLS_POLICY", before);
  }
});

test("a declared tool runs on the client over the bridge, capped, private and behind the data line", async () => {
  const jobId = `job-${crypto.randomUUID()}`;
  const signal = new AbortController().signal;
  const declared = declaredClientTools(
    [declaration("client-tracker-get-issue")],
    "on",
  );
  const session = clientToolSession(jobId, signal, declared);
  try {
    const tool = session.tools[0]!;
    assert.equal(tool.external, true);
    assert.equal(tool.private, true);
    assert.deepEqual(
      (tool.tool as { function: { parameters: unknown } }).function.parameters,
      object,
    );
    const running = tool.run({ id: "7" });
    const [call] = drainPendingToolCalls(jobId);
    assert.equal(call?.name, "client-tracker-get-issue");
    assert.deepEqual(call?.arguments, { id: "7" });
    applyToolResults(jobId, [
      {
        callId: call!.callId,
        output: "z".repeat(CLIENT_TOOL_RESULT_MAX_CHARS + 500),
      },
    ]);
    const output = await running;
    assert.ok(output.startsWith("z".repeat(CLIENT_TOOL_RESULT_MAX_CHARS)));
    assert.ok(output.endsWith("...[truncated]"));
    assert.ok(output.length < CLIENT_TOOL_RESULT_MAX_CHARS + 100);
    assert.deepEqual(session.privateResults(), [output]);
  } finally {
    clearRemoteToolBridge(jobId);
  }
});

test("declared tools join the MCP session: tools, warnings and private results, MCP servers only in the Metadata", async () => {
  const declared = declaredClientTools(
    [declaration("client-a"), declaration("x")],
    "on",
  );
  const client = clientToolSession(
    "job-join",
    new AbortController().signal,
    declared,
  );
  const servers = { ...emptyMcpSession(), servers: ["tracker"] };
  const joined = joinMcpSessions(servers, client);
  assert.deepEqual(joined.servers, ["tracker"]);
  assert.deepEqual(
    joined.tools.map((tool) => tool.name),
    ["client-a"],
  );
  assert.deepEqual(codes(joined.warnings()), ["client_tools_refused"]);
  await joined.stop();
});

test("the prompt's private results sentence names declared tools one by one", () => {
  const rule =
    "are private. Base a finding on them when they show the change is wrong, and say only that a private source of this repository requires it. Never quote, paraphrase or summarize their text in a finding.";
  assert.equal(privateToolsGuidance([{ name: "search-non-code" }]), undefined);
  assert.equal(
    privateToolsGuidance([{ name: "mcp-tracker-get_issue" }]),
    `Results from mcp- tools ${rule}`,
  );
  assert.equal(
    privateToolsGuidance([{ name: "client-a", private: true }]),
    `Results from the client tool client-a ${rule}`,
  );
  assert.equal(
    privateToolsGuidance([
      { name: "mcp-tracker-get_issue" },
      { name: "client-a", private: true },
      { name: "client-b", private: true },
    ]),
    `Results from mcp- tools and from the client tools client-a, client-b ${rule}`,
  );
});

test("the declared tools together stay under the total limit", () => {
  // Each one is just under the single limit, so only a few fit the total.
  const big = (index: number) => ({
    name: `client-big-${index}`,
    description: "d".repeat(MAX_CLIENT_TOOL_DECLARATION_BYTES - 200),
  });
  const result = declaredClientTools(
    Array.from({ length: 10 }, (_, index) => big(index)),
    "on",
  );
  const size = result.tools.reduce(
    (sum, tool) => sum + JSON.stringify(tool).length,
    0,
  );
  assert.ok(result.tools.length >= 1 && result.tools.length < 10);
  assert.ok(size <= MAX_CLIENT_TOOLS_TOTAL_BYTES + 10 * 1024);
  assert.ok(
    result.warnings.some((warning) =>
      warning.message.includes("together are over"),
    ),
  );
});
