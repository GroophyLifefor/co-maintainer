/** Fake Anthropic Messages API server for `anthropic.test.ts`.
 *
 * A real HTTP server, matching {@link startFakeOpenAi}'s shape: `/v1/models`
 * for verification, `/v1/messages` for the provider's own calls. The provider
 * points at it through `CM_ANTHROPIC_URL`. */
import { createServer, type Server } from "node:http";

export type FakeAnthropicMode =
  | "success"
  | "tools"
  | "structured-output"
  | "refusal"
  | "bad-model"
  | "unauthorized"
  | "rate-limited";

export type FakeAnthropic = {
  url: string;
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
};

type Json = Record<string, unknown>;

const MODELS = ["claude-opus-5", "claude-haiku-4-5", "fake-model"];

function messageResponse(
  model: string,
  text: string,
  usage = { input: 10, output: 5 },
): Json {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  };
}

function modelOf(body: Json): string {
  return typeof body.model === "string" ? body.model : "fake-model";
}

/** A single `get_weather` call the first time, then a plain answer once the
 * tool's result comes back as a `tool_result` block in a user message. */
function toolsResponse(body: Json): Json {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasResult = messages.some(
    (message) =>
      message &&
      typeof message === "object" &&
      Array.isArray((message as Json).content) &&
      ((message as Json).content as Json[]).some(
        (block) => block && (block as Json).type === "tool_result",
      ),
  );
  if (hasResult) return messageResponse(modelOf(body), "The weather is fine.");
  return {
    id: "msg_fake_call",
    type: "message",
    role: "assistant",
    model: modelOf(body),
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "get_weather",
        input: { location: "Paris" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 8, output_tokens: 4 },
  };
}

function errorBody(type: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message } });
}

function reply(
  mode: FakeAnthropicMode,
  body: Json,
): { status: number; body: string } {
  switch (mode) {
    case "bad-model":
      return {
        status: 404,
        body: errorBody("not_found_error", "model: unknown model"),
      };
    case "unauthorized":
      return {
        status: 401,
        body: errorBody("authentication_error", "invalid x-api-key"),
      };
    case "rate-limited":
      return {
        status: 429,
        body: errorBody("rate_limit_error", "slow down"),
      };
    case "tools":
      return { status: 200, body: JSON.stringify(toolsResponse(body)) };
    case "structured-output":
      return {
        status: 200,
        body: JSON.stringify(messageResponse(modelOf(body), '{"findings":[]}')),
      };
    case "refusal":
      return {
        status: 200,
        body: JSON.stringify({
          id: "msg_refusal",
          type: "message",
          role: "assistant",
          model: modelOf(body),
          content: [],
          stop_reason: "refusal",
          stop_sequence: null,
          stop_details: {
            type: "refusal",
            explanation: "cannot help with that",
          },
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
      };
    case "success":
    default:
      return {
        status: 200,
        body: JSON.stringify(messageResponse(modelOf(body), "All clear.")),
      };
  }
}

export function startFakeAnthropic(
  mode: FakeAnthropicMode = "success",
): Promise<FakeAnthropic> {
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method === "GET" && path.endsWith("/models")) {
        if (mode === "unauthorized") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(errorBody("authentication_error", "invalid x-api-key"));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: MODELS.map((id) => ({ id, type: "model" })),
          }),
        );
        return;
      }
      let parsed: Json = {};
      try {
        parsed = JSON.parse(raw) as Json;
        requests.push(parsed);
      } catch {
        requests.push({ __unparsed: raw });
      }
      const { status, body } = reply(mode, parsed);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fake Anthropic did not get a port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
