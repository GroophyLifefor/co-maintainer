import { test } from "node:test";
import { OpenAiProvider, openAiError } from "./openai.ts";
import { verifyOpenAi } from "./verify.ts";
import { completeWithMermaidTools } from "./mermaid_loop.ts";
import { FINDINGS_JSON_SCHEMA } from "../pr/findings_json.ts";
import { startFakeOpenAi } from "../testing/fake_openai.ts";
import { CliError, EXIT_RUNTIME, EXIT_USAGE } from "../cli/error.ts";
import { deleteEnv, getEnv, setEnv } from "../util/runtime.ts";
import type { AiRequest } from "../types.ts";

const request: AiRequest = { job: "test", prompt: "hello", maxTokens: 100 };

async function withFakeOpenAi<T>(
  mode: Parameters<typeof startFakeOpenAi>[0],
  fn: (provider: OpenAiProvider, url: string) => Promise<T>,
): Promise<T> {
  const fake = await startFakeOpenAi(mode);
  const original = getEnv("CM_OPENAI_URL");
  setEnv("CM_OPENAI_URL", fake.url);
  try {
    return await fn(new OpenAiProvider("sk-test", "fake-model"), fake.url);
  } finally {
    if (original === undefined) deleteEnv("CM_OPENAI_URL");
    else setEnv("CM_OPENAI_URL", original);
    await fake.close();
  }
}

test("OpenAiProvider parses a message response and reports no cost", async () => {
  await withFakeOpenAi("success", async (provider) => {
    const response = await provider.complete(request);
    if (response.text !== "All clear.") throw new Error(response.text);
    if (response.tokensIn !== 10 || response.tokensOut !== 5) {
      throw new Error(JSON.stringify(response));
    }
    if (response.cost !== undefined)
      throw new Error("OpenAI never reports a cost");
    if (response.provider !== "openai") throw new Error(response.provider);
  });
});

test("OpenAiProvider sends instructions separately and the flat function tool shape", async () => {
  const fake = await startFakeOpenAi("success");
  const original = getEnv("CM_OPENAI_URL");
  setEnv("CM_OPENAI_URL", fake.url);
  try {
    const provider = new OpenAiProvider("sk-test", "fake-model");
    await provider.complete({
      ...request,
      system: "be terse",
      tools: [
        {
          type: "function",
          function: { name: "ping", description: "pings", parameters: {} },
        },
      ],
    });
    const sent = fake.requests[0]!;
    if (sent.instructions !== "be terse") throw new Error(JSON.stringify(sent));
    const tools = sent.tools as Record<string, unknown>[];
    if (tools[0]?.type !== "function" || tools[0]?.name !== "ping") {
      throw new Error(`flat tool shape expected: ${JSON.stringify(tools)}`);
    }
    if (tools[0]?.function !== undefined) {
      throw new Error("Responses tools must not nest under function");
    }
  } finally {
    if (original === undefined) deleteEnv("CM_OPENAI_URL");
    else setEnv("CM_OPENAI_URL", original);
    await fake.close();
  }
});

test("a tool round trip: function_call out, function_call_output back in", async () => {
  await withFakeOpenAi("tools", async (provider) => {
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
  });
});

test("structured output asks for text.format and falls back to the parsed reply", async () => {
  await withFakeOpenAi("structured-output", async (provider) => {
    const response = await provider.complete({
      ...request,
      responseFormat: FINDINGS_JSON_SCHEMA,
    });
    if (response.text !== '{"findings":[]}') throw new Error(response.text);
  });
});

test("a refusal is a clear runtime error, not a silently empty answer", async () => {
  await withFakeOpenAi("refusal", async (provider) => {
    let error: unknown;
    try {
      await provider.complete(request);
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof CliError) || !/refused/.test(error.message)) {
      throw new Error(String(error));
    }
  });
});

test("a bad model and an unauthorized key are usage errors, exit 2", async () => {
  await withFakeOpenAi("bad-model", async (provider) => {
    let error: unknown;
    try {
      await provider.complete(request);
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof CliError) || error.exitCode !== EXIT_USAGE) {
      throw new Error(String(error));
    }
    if (error.code !== "openai_unknown_model") throw new Error(error.code);
  });
  await withFakeOpenAi("unauthorized", async (provider) => {
    let error: unknown;
    try {
      await provider.complete(request);
    } catch (caught) {
      error = caught;
    }
    if (
      !(error instanceof CliError) ||
      error.exitCode !== EXIT_USAGE ||
      error.code !== "openai_unauthorized"
    ) {
      throw new Error(String(error));
    }
  });
});

test("a rate limit is a runtime failure, exit 3", async () => {
  await withFakeOpenAi("rate-limited", async (provider) => {
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

test("openAiError reads only error.message from the body", () => {
  const error = openAiError(
    "m",
    500,
    JSON.stringify({ error: { message: "boom" } }),
  );
  if (error.message !== "OpenAI failed with 500: boom")
    throw new Error(error.message);
});

async function withVerifyEnv<T>(
  mode: Parameters<typeof startFakeOpenAi>[0],
  fn: () => Promise<T>,
): Promise<T> {
  const fake = await startFakeOpenAi(mode);
  const original = getEnv("CM_OPENAI_URL");
  setEnv("CM_OPENAI_URL", fake.url);
  try {
    return await fn();
  } finally {
    if (original === undefined) deleteEnv("CM_OPENAI_URL");
    else setEnv("CM_OPENAI_URL", original);
    await fake.close();
  }
}

test("verifyOpenAi checks the key and, when given one, the model", async () => {
  await withVerifyEnv("success", async () => {
    const ok = await verifyOpenAi("sk-test", "fake-model");
    if (ok.status !== "ok") throw new Error(JSON.stringify(ok));
    const unknown = await verifyOpenAi("sk-test", "no-such-model");
    if (unknown.status !== "rejected") throw new Error(JSON.stringify(unknown));
  });
});

test("verifyOpenAi rejects a bad key", async () => {
  await withVerifyEnv("unauthorized", async () => {
    const result = await verifyOpenAi("sk-bad", undefined);
    if (result.status !== "rejected") throw new Error(JSON.stringify(result));
  });
});

test("a 400 that only mentions the model is not an unknown model", () => {
  for (const message of [
    "This model's maximum context length is 128000 tokens.",
    "'reasoning.effort' is not supported with this model.",
  ]) {
    const error = openAiError(
      "gpt-test",
      400,
      JSON.stringify({ error: { message, code: "invalid_request_error" } }),
    );
    if (error.code === "openai_unknown_model") throw new Error(message);
  }
  const unknown = openAiError(
    "gpt-test",
    404,
    JSON.stringify({
      error: { message: "The model does not exist", code: "model_not_found" },
    }),
  );
  if (unknown.code !== "openai_unknown_model") throw new Error(unknown.code);
});
