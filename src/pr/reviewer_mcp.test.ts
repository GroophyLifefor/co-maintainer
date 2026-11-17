/** A review with a repository's MCP server (issue 79): the tools offered, the
 * private results sentence, the data line, the copied-passage check on the
 * review text, the warnings, and the server stopped however the review
 * ends. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs, setCliInteractive } from "../cli/args.ts";
import type { Revision } from "../review/revision.ts";
import type {
  AiProvider,
  AiRequest,
  AiResponse,
  GitHubClient,
  Json,
  Options,
} from "../types.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import {
  FAKE_MCP_ISSUE_TEXT,
  writeFakeMcpServer,
} from "../testing/fake_mcp_server.ts";
import { EXTERNAL_RESULT_LINE } from "../ai/tool_gate.ts";
import {
  MCP_PRIVATE_GUIDANCE,
  PRIVATE_TEXT_REMOVED,
} from "../review/private_text.ts";
import { reviewPullRequest, reviewWorkspaceRevision } from "./reviewer.ts";

/** Reads the issue, then writes a finding that copies it. `fail` makes the
 * second answer throw instead. `plainFirst` makes the second answer prose
 * that copies it, so the review asks once more for JSON. */
class CopyingProvider implements AiProvider {
  requests: AiRequest[] = [];
  private readonly fail: boolean;
  private readonly plainFirst: boolean;
  constructor(fail = false, plainFirst = false) {
    this.fail = fail;
    this.plainFirst = plainFirst;
  }

  complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(structuredClone(request));
    const base = {
      tokensIn: 1,
      tokensOut: 1,
      provider: "openrouter" as const,
      model: "test",
    };
    if (this.requests.length === 1) {
      return Promise.resolve({
        ...base,
        text: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function" as const,
            function: {
              name: "mcp-tracker-get_issue",
              arguments: JSON.stringify({ id: "7" }),
            },
          },
        ],
      });
    }
    if (this.fail) return Promise.reject(new Error("provider down"));
    if (this.plainFirst && this.requests.length === 2) {
      return Promise.resolve({
        ...base,
        text: `The tracker says: ${FAKE_MCP_ISSUE_TEXT}.`,
      });
    }
    return Promise.resolve({
      ...base,
      text: JSON.stringify({
        findings: [
          {
            severity: "P2",
            path: "src/export.ts",
            lineFrom: 2,
            title: "Export stops at a thousand rows",
            body: `The tracker says: ${FAKE_MCP_ISSUE_TEXT}. The new limit causes it.`,
          },
        ],
      }),
    });
  }
}

const REVISION: Revision = {
  title: "",
  description: "",
  baseLabel: "main",
  producer: "local",
  files: [
    {
      path: "src/export.ts",
      previousPath: null,
      status: "modified",
      binary: false,
      additions: 1,
      deletions: 0,
      patch:
        "@@ -1,1 +1,2 @@\n export const PAGE = 100\n+export const LIMIT = 1000",
    },
  ],
};

class FakeClient implements GitHubClient {
  request<T>(): Promise<T> {
    return Promise.resolve({
      number: 1,
      title: "Raise the export limit",
      body: "",
      state: "open",
      base: { ref: "main" },
    } as T);
  }

  pages<T>(endpoint: string): Promise<T[]> {
    if (!endpoint.endsWith("/files")) return Promise.resolve([] as T[]);
    const file = REVISION.files[0]!;
    return Promise.resolve([
      {
        filename: file.path,
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: file.patch,
      },
    ] as Json[] as T[]);
  }
}

/** One review with the fake MCP server, local by default. Its temporary
 * directory is removed however it ends, after checking the server stopped. */
async function review(
  provider: CopyingProvider,
  mcpDisabled = false,
  run: { pull?: boolean; options?: Partial<Options> } = {},
) {
  const dir = tempDirSync();
  const exitFile = join(dir, "server-exited");
  const saved = {
    config: getEnv("CM_CONFIG_PATH"),
    repos: getEnv("CM_REPOS_DIR"),
    disabled: getEnv("CM_MCP_DISABLED"),
  };
  try {
    setEnv("CM_CONFIG_PATH", join(dir, "config.json"));
    setEnv("CM_REPOS_DIR", join(dir, "repos"));
    if (mcpDisabled) setEnv("CM_MCP_DISABLED", "1");
    else deleteEnv("CM_MCP_DISABLED");
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        repos: {
          "acme/widgets": {
            mcpServers: {
              tracker: {
                command: process.execPath,
                args: [writeFakeMcpServer(dir)],
                env: { FAKE_MCP_EXIT_FILE: exitFile },
                tools: ["get_issue", "close_issue"],
              },
            },
          },
        },
      }),
    );
    mkdirSync(join(dir, "repos/acme/widgets"), { recursive: true });
    writeFileSync(
      join(dir, "repos/acme/widgets/PR_REVIEW_GUIDE.md"),
      "Review small changes.",
    );
    setCliInteractive(false);
    const options: Options = {
      ...(await parseArgs([
        "review",
        "acme/widgets",
        "--token=test",
        "--low-model=low/model",
        "--high-model=test/model",
      ])),
      useCodegraph: false,
      ...run.options,
    };
    const tools = {
      kind: "tree" as const,
      root: dir,
      codegraph: [],
      mcp: true,
    };
    try {
      const outcome = run.pull
        ? await reviewPullRequest(
            new FakeClient(),
            { ...options, prNumber: 1 },
            undefined,
            undefined,
            provider,
            undefined,
            { tools },
          )
        : await reviewWorkspaceRevision(
            REVISION,
            options,
            "abc123",
            undefined,
            provider,
            undefined,
            { tools },
          );
      return { outcome, stopped: existsSync(exitFile) };
    } catch (error) {
      return { error, stopped: existsSync(exitFile) };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    setCliInteractive(true);
    const restore = (name: string, value: string | undefined) =>
      value === undefined ? deleteEnv(name) : setEnv(name, value);
    restore("CM_CONFIG_PATH", saved.config);
    restore("CM_REPOS_DIR", saved.repos);
    restore("CM_MCP_DISABLED", saved.disabled);
  }
}

const offered = (request: AiRequest | undefined) =>
  (request?.tools ?? []).map(
    (tool) => (tool as { function?: { name?: string } }).function?.name,
  );

/** Any 8 consecutive words of the private text, lowercased. */
function hasRun(text: string, source: string): boolean {
  const words = (value: string) =>
    value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const haystack = ` ${words(text).join(" ")} `;
  const list = words(source);
  for (let i = 0; i + 8 <= list.length; i++) {
    if (haystack.includes(` ${list.slice(i, i + 8).join(" ")} `)) return true;
  }
  return false;
}

test("an MCP tool is offered and read, and its text never reaches the review", async () => {
  const provider = new CopyingProvider();
  const { outcome, stopped } = await review(provider);
  assert.ok(outcome);
  const first = provider.requests[0];
  assert.ok(offered(first).includes("mcp-tracker-get_issue"));
  assert.ok(!offered(first).includes("mcp-tracker-close_issue"));
  assert.ok(first?.prompt.includes(MCP_PRIVATE_GUIDANCE));
  const result = (provider.requests[1]?.messages ?? []).find(
    (message) => message.role === "tool",
  );
  assert.ok(
    String(result?.content).startsWith(
      `${EXTERNAL_RESULT_LINE}\n${FAKE_MCP_ISSUE_TEXT}`,
    ),
  );
  assert.ok(!hasRun(outcome.text, FAKE_MCP_ISSUE_TEXT));
  assert.ok(outcome.text.includes(PRIVATE_TEXT_REMOVED));
  const codes = outcome.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("mcp_tool_refused"));
  assert.ok(codes.includes("private_text_removed"));
  assert.ok(
    !outcome.warnings.some((warning) =>
      hasRun(warning.message, FAKE_MCP_ISSUE_TEXT),
    ),
  );
  assert.deepEqual(outcome.mcpServers, ["tracker"]);
  assert.deepEqual(outcome.tools.byTool, { "mcp-tracker-get_issue": 1 });
  assert.ok(stopped, "the server was stopped");
});

test("a review that fails still stops its MCP server", async () => {
  const { error, stopped } = await review(new CopyingProvider(true));
  assert.match(String(error), /provider down/);
  assert.ok(stopped, "the server was stopped");
});

test("with CM_MCP_DISABLED=1 the review offers no MCP tool", async () => {
  const provider = new CopyingProvider();
  const { outcome } = await review(provider, true);
  assert.ok(outcome);
  assert.ok(
    !offered(provider.requests[0]).some((name) => name?.startsWith("mcp-")),
  );
  assert.ok(!provider.requests[0]?.prompt.includes(MCP_PRIVATE_GUIDANCE));
  assert.deepEqual(outcome.mcpServers, []);
});

test("a debug review prints model text only after the copied-passage check", async () => {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  };
  let result: Awaited<ReturnType<typeof review>>;
  try {
    result = await review(new CopyingProvider(false, true), false, {
      pull: true,
      options: { debug: true, improveMatrix: 2 },
    });
  } finally {
    console.log = log;
  }
  assert.ok(result.outcome, String(result.error));
  const output = printed.join("\n");
  for (const heading of ["INITIAL REVIEW", "JSON RETRY", "IMPROVED REVIEW 1"]) {
    assert.ok(output.includes(`----- ${heading} -----`), heading);
  }
  assert.ok(output.includes(PRIVATE_TEXT_REMOVED));
  assert.ok(!hasRun(output, FAKE_MCP_ISSUE_TEXT));
  assert.ok(!hasRun(result.outcome.text, FAKE_MCP_ISSUE_TEXT));
});
