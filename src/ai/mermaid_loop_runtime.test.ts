/** The tool list when a PlantUML runtime is chosen. */
import { test } from "node:test";
import { completeWithMermaidTools } from "./mermaid_loop.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";

class RecordingProvider implements AiProvider {
  requests: AiRequest[] = [];

  complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      text: "done",
      tokensIn: 1,
      tokensOut: 1,
      provider: "openrouter",
      model: "test",
    });
  }
}

const toolNames = (request: AiRequest): string[] =>
  ((request.tools ?? []) as { function: { name: string } }[]).map(
    (tool) => tool.function.name,
  );

const REQUEST: AiRequest = { job: "test", prompt: "Explain", maxTokens: 100 };

test("the Mermaid tool is offered unless the request leaves it out", async () => {
  const offered = new RecordingProvider();
  await completeWithMermaidTools(offered, REQUEST, 1);
  if (!toolNames(offered.requests[0]!).includes("read-mermaid-syntaxes")) {
    throw new Error(JSON.stringify(offered.requests[0]));
  }
  const left = new RecordingProvider();
  await completeWithMermaidTools(
    left,
    { ...REQUEST, withoutMermaidTool: true },
    1,
  );
  if (toolNames(left.requests[0]!).length !== 0) {
    throw new Error(JSON.stringify(left.requests[0]));
  }
});

test("a PlantUML request keeps the other review tools", async () => {
  const provider = new RecordingProvider();
  const extra = {
    name: "read-full-diff",
    tool: { type: "function", function: { name: "read-full-diff" } },
    run: () => "diff",
  };
  await completeWithMermaidTools(
    provider,
    { ...REQUEST, withoutMermaidTool: true },
    1,
    [extra],
  );
  const names = toolNames(provider.requests[0]!);
  if (names.length !== 1 || names[0] !== "read-full-diff") {
    throw new Error(names.join(","));
  }
});
