import { completeWithMermaidTools } from "./mermaid_loop.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";

function toolCall(name: string, tools: string[]) {
  return [{
    id: `call-${name}`,
    type: "function" as const,
    function: { name, arguments: JSON.stringify({ tools }) },
  }];
}

class ScriptedProvider implements AiProvider {
  readonly supportsTools = true;
  requests: AiRequest[] = [];

  constructor(private readonly script: Partial<AiResponse>[]) {}

  complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(structuredClone(request));
    const step = this.script[this.requests.length - 1] ??
      this.script[this.script.length - 1];
    return Promise.resolve({
      text: "",
      tokensIn: 1,
      tokensOut: 2,
      provider: "openrouter",
      model: "test",
      ...step,
    });
  }
}

const ask = (provider: AiProvider, maxTools = 1) =>
  completeWithMermaidTools(provider, {
    job: "test",
    prompt: "Explain the tree",
    maxTokens: 100,
  }, maxTools);

Deno.test("Mermaid tool loop returns final text after reading requested docs", async () => {
  const provider = new ScriptedProvider([
    { toolCalls: toolCall("read-mermaid-syntaxes", ["treeView-beta"]) },
    {
      text: "## Findings\n\nNo actionable findings.",
      tokensIn: 2,
      tokensOut: 3,
    },
  ]);
  const result = await ask(provider);
  if (!result.text.includes("No actionable findings")) {
    throw new Error(result.text);
  }
  if (result.tokensIn !== 3 || result.tokensOut !== 5) {
    throw new Error(`tokens were not summed ${JSON.stringify(result)}`);
  }
  if (result.cost !== undefined) {
    throw new Error("unreported cost must stay unknown, not zero");
  }
  const messages = provider.requests[1].messages ?? [];
  const tool = messages.find((message) => message.role === "tool");
  if (
    !tool?.content?.includes("treeView-beta") ||
    !tool.content.includes("rowIndent")
  ) {
    throw new Error(`missing tool result ${JSON.stringify(messages)}`);
  }
});

Deno.test("a model that never stops calling tools still gets a final answer", async () => {
  const provider = new ScriptedProvider([
    { toolCalls: toolCall("read-mermaid-syntaxes", ["flowchart"]) },
    { toolCalls: toolCall("read-mermaid-syntaxes", ["erDiagram"]) },
    { toolCalls: toolCall("read-mermaid-syntaxes", ["classDiagram"]) },
    { text: "final answer" },
  ]);
  const result = await ask(provider);
  if (result.text !== "final answer") throw new Error(result.text);
  const last = provider.requests[provider.requests.length - 1];
  if (last.tools) throw new Error("the closing call must drop the tools");
});

Deno.test("an unknown tool name becomes a tool error instead of killing the job", async () => {
  const provider = new ScriptedProvider([
    { toolCalls: toolCall("read-the-whole-repo", ["flowchart"]) },
    { text: "recovered" },
  ]);
  const result = await ask(provider);
  if (result.text !== "recovered") throw new Error(result.text);
  const tool = (provider.requests[1].messages ?? []).find((message) =>
    message.role === "tool"
  );
  if (!tool?.content?.includes("Tool error: unsupported tool")) {
    throw new Error(`expected a tool error ${tool?.content}`);
  }
});

Deno.test("a caller supplied message list is not mutated", async () => {
  const messages = [{ role: "user" as const, content: "hello" }];
  const provider = new ScriptedProvider([
    { toolCalls: toolCall("read-mermaid-syntaxes", ["flowchart"]) },
    { text: "done" },
  ]);
  await completeWithMermaidTools(provider, {
    job: "test",
    prompt: "hello",
    messages,
    maxTokens: 100,
  }, 1);
  if (messages.length !== 1) {
    throw new Error(`caller messages were mutated ${JSON.stringify(messages)}`);
  }
});

Deno.test("cost is summed across tool rounds when the provider reports it", async () => {
  const provider = new ScriptedProvider([
    { toolCalls: toolCall("read-mermaid-syntaxes", ["flowchart"]), cost: 0.25 },
    { text: "done", cost: 0.5 },
  ]);
  const result = await ask(provider);
  if (result.cost !== 0.75) throw new Error(`cost was ${result.cost}`);
});
