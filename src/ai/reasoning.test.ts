/** The global reasoning effort: high unless config.json says otherwise,
 * `default` sends no reasoning field, and a provider that refuses the field
 * gets one retry without it, at any level. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isolateTestFile } from "../testing/locations.ts";
import { writeUserConfig } from "../config.ts";
import {
  DEFAULT_GLOBAL_REASONING_EFFORT,
  GLOBAL_REASONING_EFFORTS,
  globalReasoningEffort,
  isGlobalReasoningEffort,
  reasoningFields,
} from "./reasoning.ts";
import { chatBody, withoutRefusedPart } from "./provider.ts";
import { OpenRouterProvider, type ChatHost } from "./openrouter.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAiProvider } from "./openai.ts";
import type { AiRequest } from "../types.ts";

// reasoningFields() with no argument reads the config. Keep it in a temp home.
isolateTestFile();

const request: AiRequest = { job: "test", prompt: "hello", maxTokens: 10 };

// The exact refusal an OpenCode Go model behind the Responses API returned.
const OPENCODE_REFUSAL =
  "reasoning: cannot be represented by openai-responses. use scoped provider_options when the destination has an equivalent option";

test("the levels are the six the setting offers, high by default", () => {
  assert.deepEqual(
    [...GLOBAL_REASONING_EFFORTS],
    ["none", "low", "default", "high", "xhigh", "max"],
  );
  assert.equal(DEFAULT_GLOBAL_REASONING_EFFORT, "high");
  assert.equal(globalReasoningEffort({}), "high");
  assert.equal(
    globalReasoningEffort({ globalReasoningEffort: "medium" }),
    "high",
  );
  assert.ok(isGlobalReasoningEffort("xhigh"));
  assert.ok(!isGlobalReasoningEffort("medium"));
});

test("each level becomes the request field, and default sends none", () => {
  for (const level of ["none", "low", "high", "xhigh", "max"] as const) {
    assert.deepEqual(reasoningFields({ globalReasoningEffort: level }), {
      reasoningEffort: level,
    });
  }
  const none = reasoningFields({ globalReasoningEffort: "default" });
  assert.deepEqual(none, {});
  assert.ok(!("reasoning" in chatBody("m", { ...request, ...none })));
});

test("with nothing saved a job asks for high, and the saved level wins", async () => {
  assert.deepEqual(reasoningFields(), { reasoningEffort: "high" });
  await writeUserConfig({ globalReasoningEffort: "low" });
  assert.deepEqual(reasoningFields(), { reasoningEffort: "low" });
  await writeUserConfig({ globalReasoningEffort: undefined });
});

test("a 400 about reasoning drops the level at any value, a schema 400 drops the schema", () => {
  for (const level of ["none", "low", "high", "xhigh", "max"] as const) {
    const lighter = withoutRefusedPart(
      { ...request, reasoningEffort: level },
      OPENCODE_REFUSAL,
      /response_format|json_schema|structured/i,
    );
    assert.ok(lighter && !("reasoningEffort" in lighter), level);
  }
  assert.equal(
    withoutRefusedPart(request, OPENCODE_REFUSAL, /json_schema/i),
    undefined,
  );
});

async function withFetch<T>(
  handler: (body: Record<string, unknown>) => Response,
  fn: (bodies: Record<string, unknown>[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return handler(body);
  }) as typeof fetch;
  try {
    return await fn(bodies);
  } finally {
    globalThis.fetch = original;
  }
}

const refusal = () =>
  new Response(JSON.stringify({ error: { message: OPENCODE_REFUSAL } }), {
    status: 400,
  });

test("OpenCode Go refusing reasoning at high is retried without it and marked", async () => {
  const host: ChatHost = {
    provider: "opencode-go",
    name: "OpenCode Go",
    code: "opencode_go",
    endpoint: "http://127.0.0.1:1/v1/chat/completions",
    headers: {},
    modelHint: "",
  };
  await withFetch(
    (body) =>
      "reasoning" in body
        ? refusal()
        : new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          ),
    async (bodies) => {
      const provider = new OpenRouterProvider("k", "muse-spark", host);
      const result = await provider.complete({
        ...request,
        reasoningEffort: "high",
      });
      assert.equal(result.text, "ok");
      assert.equal(bodies.length, 2);
      assert.deepEqual(bodies[0]!.reasoning, { effort: "high" });
      assert.ok(!("reasoning" in bodies[1]!));
      assert.equal(result.reasoningDropped, true);
    },
  );
});

test("an answer that kept its level is not marked", async () => {
  await withFetch(
    () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      ),
    async () => {
      const result = await new OpenRouterProvider("k", "m").complete({
        ...request,
        reasoningEffort: "high",
      });
      assert.equal(result.reasoningDropped, undefined);
    },
  );
});

test("OpenAI retries a refused level without it", async () => {
  await withFetch(
    (body) =>
      "reasoning" in body
        ? new Response(
            JSON.stringify({
              error: {
                message: "Unsupported value: 'max' for reasoning.effort",
              },
            }),
            { status: 400 },
          )
        : new Response(
            JSON.stringify({
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: "ok" }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          ),
    async (bodies) => {
      const result = await new OpenAiProvider("k", "gpt").complete({
        ...request,
        reasoningEffort: "max",
      });
      assert.equal(bodies.length, 2);
      assert.equal(result.reasoningDropped, true);
    },
  );
});

test("Anthropic retries a refused effort without it and keeps the schema", async () => {
  const schema = {
    type: "json_schema",
    json_schema: { name: "x", schema: { type: "object" } },
  };
  await withFetch(
    (body) => {
      const config = body.output_config as { effort?: string } | undefined;
      return config?.effort
        ? new Response(
            JSON.stringify({
              error: { message: "output_config.effort: unsupported value" },
            }),
            { status: 400 },
          )
        : new Response(
            JSON.stringify({
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          );
    },
    async (bodies) => {
      const result = await new AnthropicProvider("k", "claude-opus").complete({
        ...request,
        reasoningEffort: "max",
        responseFormat: schema,
      });
      assert.equal(result.text, "ok");
      assert.equal(bodies.length, 2);
      const retry = bodies[1]!.output_config as Record<string, unknown>;
      assert.ok(!("effort" in retry), "the retry still sent the effort");
      assert.ok("format" in retry, "the retry lost the schema");
      assert.equal(result.reasoningDropped, true);
    },
  );
});
