/** `review --remote` with the client's own MCP servers (issue 79), through
 * the real CLI against a fake remote server over TLS: a server with the
 * `client-tools` feature and its policy on gets each tool's name,
 * description and parameters, a server with the policy off or without the
 * feature gets no declaration and the run warns, and a slow tool batch keeps
 * syncing. */
import { test } from "node:test";
import { existsSync } from "node:fs";
import {
  createLocalReviewSandbox,
  type LocalReviewSandbox,
} from "../testing/local_review_sandbox.ts";
import {
  startFakeRemote,
  writeCaCert,
  type FakeRemote,
} from "../testing/fake_remote.ts";
import {
  FAKE_MCP_ISSUE_TEXT,
  writeFakeMcpServer,
} from "../testing/fake_mcp_server.ts";
import { runtimeExecPath, writeTextFile } from "../testing/runtime.ts";
import { commandWithInput } from "../util/runtime.ts";

type Run = { code: number; stdout: string; stderr: string };
type Tool = { name: string; description?: unknown; parameters?: unknown };
type Json = Record<string, unknown>;

const DONE = {
  schemaVersion: 1,
  status: "done",
  logs: [],
  result: { findings: [], summary: {} },
  abort: null,
};

function toolCall(name: string, args: Json = {}) {
  return {
    schemaVersion: 1,
    status: "running",
    toolCalls: [{ callId: "call-1", name, arguments: args }],
    logs: [],
    result: null,
    abort: null,
  };
}

async function withRemote(
  options: { handshake?: Json; sync?: unknown[]; waitMs?: number },
  fn: (ctx: {
    sandbox: LocalReviewSandbox;
    remote: FakeRemote;
    exitFile: string;
    run: () => Promise<Run>;
  }) => Promise<void>,
): Promise<void> {
  const sandbox = await createLocalReviewSandbox();
  let remote: FakeRemote | undefined;
  try {
    const script = writeFakeMcpServer(sandbox.home);
    const exitFile = `${sandbox.home}/mcp-exited`;
    await writeTextFile(
      `${sandbox.home}/config/config.json`,
      JSON.stringify({
        auth: "gh",
        ai: "openrouter",
        token: "fake-key",
        lowModel: "fake/model",
        highModel: "fake/model",
        repos: {
          [sandbox.repo]: {
            mcpServers: {
              tracker: {
                command: process.execPath,
                args: [script],
                env: {
                  FAKE_MCP_EXIT_FILE: exitFile,
                  FAKE_MCP_WAIT_MS: String(options.waitMs ?? 1000),
                },
                tools: ["get_issue", "close_issue", "wait"],
              },
            },
          },
        },
      }),
    );
    const started = await startFakeRemote({
      repo: sandbox.repo,
      sync: options.sync,
      handshake: options.handshake ?? {},
    });
    remote = started;
    const ca = await writeCaCert(sandbox.home);
    await fn({
      sandbox,
      remote: started,
      exitFile,
      run: async () => {
        const result = await commandWithInput(
          runtimeExecPath(),
          {
            args: sandbox.reviewArgs([
              "--remote",
              `--remote-host=${started.url}`,
              "--remote-token=cmr_inline",
              "--json",
            ]),
            cwd: sandbox.worktree,
            env: {
              ...sandbox.env("http://127.0.0.1:1"),
              NODE_EXTRA_CA_CERTS: ca,
            },
          },
          "",
        );
        return {
          code: result.code,
          stdout: new TextDecoder().decode(result.stdout),
          stderr: new TextDecoder().decode(result.stderr),
        };
      },
    });
  } finally {
    await remote?.close();
    await sandbox.cleanup();
  }
}

function submittedTools(remote: FakeRemote): Tool[] {
  const body = remote.requests.find((r) => r.path === "/api/remote/reviews")
    ?.body as { capabilities?: { tools?: Tool[] } } | undefined;
  return body?.capabilities?.tools ?? [];
}

function syncs(remote: FakeRemote): { toolResults: Json[] }[] {
  return remote.requests
    .filter((r) => r.path.endsWith("/sync"))
    .map((r) => r.body as { toolResults: Json[] });
}

function warningCodes(stdout: string): string[] {
  const body = JSON.parse(stdout) as { warnings?: { code: string }[] };
  return (body.warnings ?? []).map((warning) => warning.code);
}

function must(value: boolean, what: string): void {
  if (!value) throw new Error(what);
}

const ON = {
  serverVersion: "0.7.12",
  features: ["byok", "push", "intent", "client-tools"],
  clientTools: { policy: "on" },
};

test("a server with client-tools on gets each tool's name, description and parameters, and the client runs a declared call", async () => {
  await withRemote(
    {
      handshake: ON,
      sync: [toolCall("client-tracker-get-issue", { id: "7" }), DONE],
    },
    async (ctx) => {
      const result = await ctx.run();
      must(result.code === 0, `${result.stdout}\n${result.stderr}`);
      const tools = submittedTools(ctx.remote);
      const issue = tools.find(
        (tool) => tool.name === "client-tracker-get-issue",
      );
      must(issue !== undefined, JSON.stringify(tools));
      must(
        JSON.stringify(issue!.parameters) ===
          JSON.stringify({
            type: "object",
            properties: { id: { type: "string" } },
          }),
        JSON.stringify(issue),
      );
      must(
        typeof issue!.description === "string" &&
          issue!.description.includes("Read one issue."),
        JSON.stringify(issue),
      );
      must(
        tools.some((tool) => tool.name === "client-tracker-wait"),
        JSON.stringify(tools),
      );
      // The tool the MCP server marks as writing is never declared.
      must(
        !tools.some((tool) => tool.name.includes("close")),
        JSON.stringify(tools),
      );
      const search = tools.find((tool) => tool.name === "search-non-code");
      must(
        search?.parameters !== undefined && search.description !== undefined,
        JSON.stringify(search),
      );
      const answered = syncs(ctx.remote).flatMap((sync) => sync.toolResults);
      must(
        answered.some(
          (row) =>
            row.callId === "call-1" &&
            String(row.output).includes(FAKE_MCP_ISSUE_TEXT),
        ),
        JSON.stringify(answered),
      );
      const codes = warningCodes(result.stdout);
      must(codes.includes("mcp_tool_refused"), JSON.stringify(codes));
      must(!codes.includes("client_tools_refused"), JSON.stringify(codes));
      must(existsSync(ctx.exitFile), "the MCP server was not stopped");
      must(!result.stdout.includes(FAKE_MCP_ISSUE_TEXT), "printed the result");
    },
  );
});

test("a server with the policy off is sent no declaration, starts no MCP server, and the run warns client_tools_refused", async () => {
  await withRemote(
    { handshake: { ...ON, clientTools: { policy: "off" } } },
    async (ctx) => {
      const result = await ctx.run();
      must(result.code === 0, `${result.stdout}\n${result.stderr}`);
      const tools = submittedTools(ctx.remote);
      must(
        !tools.some((tool) => tool.name.startsWith("client-")),
        JSON.stringify(tools),
      );
      must(
        JSON.stringify(warningCodes(result.stdout)) ===
          JSON.stringify(["client_tools_refused"]),
        result.stdout,
      );
      must(
        result.stdout.includes("does not accept tools from the client"),
        result.stdout,
      );
      must(!existsSync(ctx.exitFile), "an MCP server was started");
    },
  );
});

test("an older server gets the names of its known tools only, and the run warns with its version", async () => {
  for (const handshake of [{}, { features: ["byok", "push", "intent"] }]) {
    await withRemote({ handshake }, async (ctx) => {
      const result = await ctx.run();
      must(result.code === 0, `${result.stdout}\n${result.stderr}`);
      must(
        JSON.stringify(submittedTools(ctx.remote)) ===
          JSON.stringify([{ name: "search-non-code" }]),
        JSON.stringify(submittedTools(ctx.remote)),
      );
      must(
        JSON.stringify(warningCodes(result.stdout)) ===
          JSON.stringify(["client_tools_refused"]),
        result.stdout,
      );
      must(
        result.stdout.includes(
          "This server (version 0.5.0) does not take tools from the client",
        ),
        result.stdout,
      );
      must(!existsSync(ctx.exitFile), "an MCP server was started");
    });
  }
});

test("while a slow tool batch runs, the client keeps sending syncs with no results", async () => {
  await withRemote(
    {
      handshake: { ...ON, sync: { intervalSeconds: 0.05, timeoutSeconds: 10 } },
      sync: [toolCall("client-tracker-wait"), DONE],
      waitMs: 600,
    },
    async (ctx) => {
      const result = await ctx.run();
      must(result.code === 0, `${result.stdout}\n${result.stderr}`);
      const all = syncs(ctx.remote);
      const answeredAt = all.findIndex((sync) =>
        sync.toolResults.some((row) => row.callId === "call-1"),
      );
      must(answeredAt > 0, JSON.stringify(all));
      const beats = all
        .slice(1, answeredAt)
        .filter((sync) => sync.toolResults.length === 0).length;
      must(beats >= 3, `${beats} syncs while the tool ran`);
      must(
        all[answeredAt]!.toolResults.some((row) => row.output === "waited"),
        JSON.stringify(all[answeredAt]),
      );
    },
  );
});
