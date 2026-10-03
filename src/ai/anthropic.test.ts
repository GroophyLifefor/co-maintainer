import { test } from "node:test";
import { AnthropicProvider, anthropicError } from "./anthropic.ts";
import { verifyAnthropic } from "./verify.ts";
import { completeWithMermaidTools } from "./mermaid_loop.ts";
import { FINDINGS_JSON_SCHEMA } from "../pr/findings_json.ts";
import { startFakeAnthropic } from "../testing/fake_anthropic.ts";
import { CliError, EXIT_RUNTIME, EXIT_USAGE } from "../cli/error.ts";
import { deleteEnv, getEnv, setEnv } from "../util/runtime.ts";
import type { AiRequest } from "../types.ts";

const request: AiRequest = { job: "test", prompt: "hello", maxTokens: 100 };

type Mode = Parameters<typeof startFakeAnthropic>[0];

async function withFakeAnthropic<T>(
  mode: Mode,
  fn: (
    provider: AnthropicProvider,
    fake: Awaited<ReturnType<typeof startFakeAnthropic>>,
  ) => Promise<T>,
): Promise<T> {
  const fake = await startFakeAnthropic(mode);
  const original = getEnv("CM_ANTHROPIC_URL");
  setEnv("CM_ANTHROPIC_URL", fake.url);
  try {
    return await fn(new AnthropicProvider("sk-ant-test", "fake-model"), fake);
  } finally {
    if (original === undefined) deleteEnv("CM_ANTHROPIC_URL");
    else setEnv("CM_ANTHROPIC_URL", original);
    await fake.close();
  }
}

test("AnthropicProvider parses a message response and reports no cost", async () => {
  await withFakeAnthropic("success", async (provider) => {
    const response = await provider.complete(request);
    if (response.text !== "All clear.") throw new Error(response.text);
    if (response.tokensIn !== 10 || response.tokensOut !== 5) {
      throw new Error(JSON.stringify(response));
    }
    if (response.cost !== undefined) {
      throw new Error("Anthropic never reports a cost");
    }
    if (response.provider !== "anthropic") throw new Error(response.provider);
  });
});

test("anthropic sends the system as a cached block and the input_schema tool shape", async () => {
  await withFakeAnthropic("success", async (provider, fake) => {
    await provider.complete({
      ...request,
      system: "be terse",
      tools: [
        {
          type: "function",
          function: {
            name: "ping",
            description: "pings",
            parameters: { type: "object" },
          },
        },
      ],
    });
    const sent = fake.requests[0]!;
    const system = sent.system as Record<string, unknown>[];
    if (!Array.isArray(system) || system[0]?.type !== "text") {
      throw new Error(`system block expected: ${JSON.stringify(sent.system)}`);
    }
    if (system[0]?.text !== "be terse") throw new Error(JSON.stringify(system));
    // The guide prefix is marked for prompt caching.
    const cache = system[0]?.cache_control as
      | Record<string, unknown>
      | undefined;
    if (cache?.type !== "ephemeral") {
      throw new Error(`cache_control expected: ${JSON.stringify(system)}`);
    }
    const tools = sent.tools as Record<string, unknown>[];
    if (tools[0]?.name !== "ping" || tools[0]?.input_schema === undefined) {
      throw new Error(
        `input_schema tool shape expected: ${JSON.stringify(tools)}`,
      );
    }
    if (tools[0]?.function !== undefined) {
      throw new Error("Anthropic tools must not nest under function");
    }
  });
});

test("a tool round trip: tool_use out, tool_result back in a user message", async () => {
  await withFakeAnthropic("tools", async (provider, fake) => {
    const result = await completeWithMermaidTools(
      provider,
      { ...request, prompt: "check the weather" },
      5,
      [
        {
          tool: {
            type: "function",
            function: { name: "get_weather", parameters: {} },
          },
          name: "get_weather",
          run: () => "sunny",
        },
      ],
    );
    if (result.text !== "The weather is fine.") throw new Error(result.text);
    // The second request carries the assistant's tool_use and a user message
    // with the matching tool_result, referenced by id.
    const second = fake.requests[1]!;
    const messages = second.messages as Record<string, unknown>[];
    const assistant = messages.find((m) => m.role === "assistant")!;
    const blocks = assistant.content as Record<string, unknown>[];
    if (blocks[0]?.type !== "tool_use" || blocks[0]?.id !== "toolu_1") {
      throw new Error(`tool_use expected: ${JSON.stringify(assistant)}`);
    }
    const user = messages.find(
      (m) => m.role === "user" && Array.isArray(m.content),
    )!;
    const resultBlocks = user.content as Record<string, unknown>[];
    if (
      resultBlocks[0]?.type !== "tool_result" ||
      resultBlocks[0]?.tool_use_id !== "toolu_1" ||
      resultBlocks[0]?.content !== "sunny"
    ) {
      throw new Error(`tool_result expected: ${JSON.stringify(user)}`);
    }
  });
});

test("structured output asks for output_config.format", async () => {
  await withFakeAnthropic("structured-output", async (provider, fake) => {
    const response = await provider.complete({
      ...request,
      responseFormat: FINDINGS_JSON_SCHEMA,
    });
    if (response.text !== '{"findings":[]}') throw new Error(response.text);
    const config = fake.requests[0]!.output_config as Record<string, unknown>;
    const format = config.format as Record<string, unknown>;
    if (format?.type !== "json_schema" || format?.schema === undefined) {
      throw new Error(
        `output_config.format expected: ${JSON.stringify(config)}`,
      );
    }
  });
});

test("effort is sent for Opus but never for Haiku", async () => {
  await withFakeAnthropic("success", async (_provider, fake) => {
    await new AnthropicProvider("sk-ant-test", "claude-opus-5").complete({
      ...request,
      reasoningEffort: "high",
    });
    const opus = fake.requests[0]!.output_config as Record<string, unknown>;
    if (opus?.effort !== "high") {
      throw new Error(`effort expected: ${JSON.stringify(opus)}`);
    }
    await new AnthropicProvider("sk-ant-test", "claude-haiku-4-5").complete({
      ...request,
      reasoningEffort: "high",
    });
    const haiku = fake.requests[1]!.output_config as unknown;
    if (haiku !== undefined) {
      throw new Error(
        `Haiku must not get output_config: ${JSON.stringify(haiku)}`,
      );
    }
    // Anthropic's effort values include xhigh, so it is forwarded, not dropped.
    await new AnthropicProvider("sk-ant-test", "claude-opus-5").complete({
      ...request,
      reasoningEffort: "xhigh",
    });
    const xhigh = fake.requests[2]!.output_config as Record<string, unknown>;
    if (xhigh?.effort !== "xhigh") {
      throw new Error(`xhigh effort expected: ${JSON.stringify(xhigh)}`);
    }
  });
});

test("temperature is never sent: Opus 5 rejects sampling parameters", async () => {
  await withFakeAnthropic("success", async (provider, fake) => {
    await provider.complete(request);
    if ("temperature" in fake.requests[0]!) {
      throw new Error("temperature must not be sent");
    }
  });
});

test("a refusal is a clear runtime error with its explanation", async () => {
  await withFakeAnthropic("refusal", async (provider) => {
    let error: unknown;
    try {
      await provider.complete(request);
    } catch (caught) {
      error = caught;
    }
    if (
      !(error instanceof CliError) ||
      error.code !== "anthropic_refusal" ||
      !/cannot help/.test(error.message)
    ) {
      throw new Error(String(error));
    }
  });
});

test("a bad model and an unauthorized key are usage errors, exit 2", async () => {
  await withFakeAnthropic("bad-model", async (provider) => {
    let error: unknown;
    try {
      await provider.complete(request);
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof CliError) || error.exitCode !== EXIT_USAGE) {
      throw new Error(String(error));
    }
    if (error.code !== "anthropic_unknown_model") throw new Error(error.code);
  });
  await withFakeAnthropic("unauthorized", async (provider) => {
    let error: unknown;
    try {
      await provider.complete(request);
    } catch (caught) {
      error = caught;
    }
    if (
      !(error instanceof CliError) ||
      error.exitCode !== EXIT_USAGE ||
      error.code !== "anthropic_unauthorized"
    ) {
      throw new Error(String(error));
    }
  });
});

test("a rate limit is a runtime failure, exit 3", async () => {
  await withFakeAnthropic("rate-limited", async (provider) => {
    let error: unknown;
    try {
      await provider.complete(request);
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof CliError) || error.exitCode !== EXIT_RUNTIME) {
      throw new Error(String(error));
    }
  });
});

test("anthropicError reads only the error message from the body", () => {
  const error = anthropicError(
    "m",
    500,
    JSON.stringify({ error: { type: "api_error", message: "boom" } }),
  );
  if (error.message !== "Anthropic failed with 500: boom") {
    throw new Error(error.message);
  }
});

async function withVerifyEnv<T>(mode: Mode, fn: () => Promise<T>): Promise<T> {
  const fake = await startFakeAnthropic(mode);
  const original = getEnv("CM_ANTHROPIC_URL");
  setEnv("CM_ANTHROPIC_URL", fake.url);
  try {
    return await fn();
  } finally {
    if (original === undefined) deleteEnv("CM_ANTHROPIC_URL");
    else setEnv("CM_ANTHROPIC_URL", original);
    await fake.close();
  }
}

test("verifyAnthropic checks the key and, when given one, the model", async () => {
  await withVerifyEnv("success", async () => {
    const ok = await verifyAnthropic("sk-ant-test", "claude-opus-5");
    if (ok.status !== "ok") throw new Error(JSON.stringify(ok));
    const unknown = await verifyAnthropic("sk-ant-test", "no-such-model");
    if (unknown.status !== "rejected") throw new Error(JSON.stringify(unknown));
  });
});

test("verifyAnthropic rejects a bad key", async () => {
  await withVerifyEnv("unauthorized", async () => {
    const result = await verifyAnthropic("sk-bad", undefined);
    if (result.status !== "rejected") throw new Error(JSON.stringify(result));
  });
});
