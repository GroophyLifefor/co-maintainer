/** The review tool gate (issue 79): one result is cut at the cap, the budget
 * is per review across all limited tools, codegraph is left whole, and the
 * loop reports what the tools did. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cutResult,
  DEFAULT_TOOL_BUDGET_CHARS,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  EXTERNAL_RESULT_LINE,
  externalResult,
  TOOL_BUDGET_SPENT,
  ToolGate,
  toolBudgetChars,
  toolResultMaxChars,
  toolsLine,
  toolUsageFromJson,
} from "./tool_gate.ts";
import { completeWithMermaidTools, type ToolHandler } from "./mermaid_loop.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";

test("the settings: unset is the default, 0 or below is no limit", () => {
  assert.equal(toolResultMaxChars(undefined), DEFAULT_TOOL_RESULT_MAX_CHARS);
  assert.equal(toolResultMaxChars({ reviewToolResultMaxChars: 100 }), 100);
  assert.equal(toolResultMaxChars({ reviewToolResultMaxChars: 0 }), null);
  assert.equal(toolResultMaxChars({ reviewToolResultMaxChars: -1 }), null);
  assert.equal(toolBudgetChars({}), DEFAULT_TOOL_BUDGET_CHARS);
  assert.equal(toolBudgetChars({ reviewToolBudgetChars: 500 }), 500);
  assert.equal(toolBudgetChars({ reviewToolBudgetChars: 0 }), null);
});

test("a result over the cap is cut and says where, the notice inside the cap", () => {
  const notice = "\n[cut at 40 characters]";
  assert.equal(
    cutResult("a".repeat(60), 40),
    `${"a".repeat(40 - notice.length)}${notice}`,
  );
  assert.equal(cutResult("a".repeat(60), 40).length, 40);
  assert.equal(cutResult("abc", 4), "abc");
  assert.equal(cutResult("abcdef", null), "abcdef");
  const gate = new ToolGate({ resultMaxChars: 50, budgetChars: null });
  const cut = gate.accept("search-non-code", "x".repeat(80));
  assert.equal(cut.length, 50);
  assert.ok(cut.endsWith("\n[cut at 50 characters]"));
});

test("codegraph is neither cut nor refused, and read-full-diff keeps its own cap", () => {
  const gate = new ToolGate({ resultMaxChars: 10, budgetChars: 60 });
  const big = "y".repeat(100);
  assert.equal(gate.accept("codegraph-callers", big), big);
  assert.equal(gate.refuse("codegraph-callers"), undefined);
  // Codegraph spent none of the budget, so read-full-diff still runs. It is
  // not cut at the result cap, only at what is left of the budget.
  assert.equal(gate.refuse("read-full-diff"), undefined);
  const cut = gate.accept("read-full-diff", big);
  assert.equal(cut.length, 60);
  assert.ok(cut.endsWith("\n[cut at 60 characters]"));
  // The budget paid for exactly what the model received.
  assert.equal(gate.refuse("read-full-diff"), TOOL_BUDGET_SPENT);
});

test("once the budget is spent every later limited call gets the fixed answer and a warning", () => {
  const gate = new ToolGate({ resultMaxChars: null, budgetChars: 30 });
  assert.deepEqual(gate.warnings(), []);
  assert.equal(gate.accept("search-non-code", "a".repeat(30)), "a".repeat(30));
  assert.equal(gate.refuse("search-non-code"), TOOL_BUDGET_SPENT);
  assert.equal(
    gate.accept("search-non-code", TOOL_BUDGET_SPENT, { refused: true }),
    TOOL_BUDGET_SPENT,
  );
  // A call that ran in the same round as the one that spent it is answered
  // the same way.
  assert.equal(gate.accept("read-full-diff", "late result"), TOOL_BUDGET_SPENT);
  const usage = gate.usage();
  assert.equal(usage.budgetSpent, true);
  assert.equal(usage.calls, 3);
  assert.deepEqual(usage.byTool, { "search-non-code": 2, "read-full-diff": 1 });
  const [warning] = gate.warnings();
  assert.equal(warning?.code, "tool_budget_spent");
});

test("a result from outside the repository starts with the data line", () => {
  assert.equal(externalResult("hi"), `${EXTERNAL_RESULT_LINE}\nhi`);
  const gate = new ToolGate();
  const result = gate.accept("mcp-tracker-get_issue", "issue text", {
    external: true,
  });
  assert.equal(result.split("\n")[0], EXTERNAL_RESULT_LINE);
});

test("the Tools line, and usage read back from a result JSON", () => {
  assert.equal(
    toolsLine({
      rounds: 5,
      calls: 11,
      resultChars: 18240,
      budgetSpent: false,
      byTool: {},
    }),
    "Tools: 11 calls · 18,240 characters",
  );
  assert.equal(
    toolsLine({
      rounds: 0,
      calls: 0,
      resultChars: 0,
      budgetSpent: false,
      byTool: {},
    }),
    null,
  );
  assert.equal(toolsLine(undefined), null);
  assert.deepEqual(
    toolUsageFromJson({ calls: 2, resultChars: "x", byTool: { a: 2, b: "1" } }),
    {
      rounds: 0,
      calls: 2,
      resultChars: 0,
      budgetSpent: false,
      byTool: { a: 2 },
    },
  );
  assert.equal(toolUsageFromJson("nope"), undefined);
});

/** Asks for the given calls on the first answer, then answers. */
class Scripted implements AiProvider {
  readonly supportsTools = true;
  requests: AiRequest[] = [];
  private readonly calls: string[][];
  constructor(calls: string[][]) {
    this.calls = calls;
  }
  complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(structuredClone(request));
    const names = this.calls[this.requests.length - 1];
    return Promise.resolve({
      text: names ? "" : "done",
      tokensIn: 1,
      tokensOut: 1,
      provider: "openrouter",
      model: "test",
      ...(names
        ? {
            toolCalls: names.map((name, index) => ({
              id: `call-${this.requests.length}-${index}`,
              type: "function" as const,
              function: { name, arguments: "{}" },
            })),
          }
        : {}),
    });
  }
}

function handler(name: string, result: string, ran: string[]): ToolHandler {
  return {
    name,
    tool: { type: "function", function: { name } },
    run: () => {
      ran.push(name);
      return result;
    },
  };
}

test("the loop runs every call through the gate, in call order, and counts rounds", async () => {
  const ran: string[] = [];
  const tools = [
    handler("search-non-code", "s".repeat(80), ran),
    handler("codegraph-callers", "c".repeat(100), ran),
  ];
  const provider = new Scripted([
    ["search-non-code", "codegraph-callers", "search-non-code"],
    ["search-non-code", "codegraph-callers"],
  ]);
  const gate = new ToolGate({ resultMaxChars: 60, budgetChars: 100 });
  await completeWithMermaidTools(
    provider,
    { job: "test", prompt: "p", maxTokens: 10 },
    1,
    tools,
    5,
    { gate },
  );
  const toolMessages = (round: number) =>
    (provider.requests[round]?.messages ?? [])
      .filter((message) => message.role === "tool")
      .map((message) => String(message.content));
  const first = toolMessages(1);
  assert.equal(first[0]?.length, 60);
  assert.ok(first[0]?.endsWith("\n[cut at 60 characters]"));
  assert.equal(first[1], "c".repeat(100));
  // The first search spent 60 of the 100, so the second gets the last 40.
  assert.equal(first[2]?.length, 40);
  assert.ok(first[2]?.endsWith("\n[cut at 40 characters]"));
  const second = toolMessages(2).slice(3);
  assert.equal(second[0], TOOL_BUDGET_SPENT);
  assert.equal(second[1], "c".repeat(100));
  // A refused call never runs.
  assert.deepEqual(ran.filter((name) => name === "search-non-code").length, 2);
  const usage = gate.usage();
  assert.equal(usage.rounds, 2);
  assert.equal(usage.calls, 5);
  assert.equal(usage.budgetSpent, true);
  assert.deepEqual(usage.byTool, {
    "search-non-code": 3,
    "codegraph-callers": 2,
  });
  assert.equal(
    usage.resultChars,
    first.join("").length + second.join("").length,
  );
});

test("one gate spans several loop calls, so the budget is per review", async () => {
  const ran: string[] = [];
  const tools = [handler("search-non-code", "z".repeat(20), ran)];
  const gate = new ToolGate({ resultMaxChars: null, budgetChars: 20 });
  for (let pass = 0; pass < 2; pass++) {
    await completeWithMermaidTools(
      new Scripted([["search-non-code"]]),
      { job: "test", prompt: "p", maxTokens: 10 },
      1,
      tools,
      5,
      { gate },
    );
  }
  assert.equal(ran.length, 1);
  assert.equal(gate.usage().calls, 2);
  assert.equal(gate.usage().budgetSpent, true);
});
