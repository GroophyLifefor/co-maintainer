/** Fake OpenAI Responses API server for `openai.test.ts`.
 *
 * A real HTTP server, matching {@link startFakeOpenRouter}'s shape: `/v1/models`
 * for verification, `/v1/responses` for the provider's own calls. */
import { createServer, type Server } from "node:http";

export type FakeOpenAiMode =
  | "success"
  | "tools"
  | "structured-output"
  | "refusal"
  | "bad-model"
  | "unauthorized"
  | "rate-limited";

export type FakeOpenAi = {
  url: string;
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
};

type Json = Record<string, unknown>;

const MODELS = ["fake-model", "low-model", "high-model"];

function messageResponse(text: string, usage = { input: 10, output: 5 }): Json {
  return {
    id: "resp_fake",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  };
}

/** A single `get-weather` call the first time, then a plain answer once the
 * tool's output comes back (the `function_call_output` item in `input`). */
function toolsResponse(body: Json): Json {
  const input = Array.isArray(body.input) ? body.input : [];
  const hasResult = input.some(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as Json).type === "function_call_output",
  );
  if (hasResult) return messageResponse("The weather is fine.");
  return {
    id: "resp_fake_call",
    output: [
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"location":"Paris"}',
      },
    ],
    usage: { input_tokens: 8, output_tokens: 4 },
  };
}

function errorBody(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

function reply(
  mode: FakeOpenAiMode,
  body: Json,
): { status: number; body: string } {
  switch (mode) {
    case "bad-model":
      return {
        status: 400,
        body: errorBody("model_not_found", "The model does not exist"),
      };
    case "unauthorized":
      return {
        status: 401,
        body: errorBody("invalid_api_key", "Incorrect API key"),
      };
    case "rate-limited":
      return {
        status: 429,
        body: errorBody("rate_limit_exceeded", "Slow down"),
      };
    case "tools":
      return { status: 200, body: JSON.stringify(toolsResponse(body)) };
    case "structured-output":
      return {
        status: 200,
        body: JSON.stringify(messageResponse('{"findings":[]}')),
      };
    case "refusal":
      return {
        status: 200,
        body: JSON.stringify({
          id: "resp_refusal",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "refusal", refusal: "cannot help with that" }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
      };
    case "success":
    default:
      return {
        status: 200,
        body: JSON.stringify(messageResponse("All clear.")),
      };
  }
}

export function startFakeOpenAi(
  mode: FakeOpenAiMode = "success",
): Promise<FakeOpenAi> {
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
          response.end(errorBody("invalid_api_key", "Incorrect API key"));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: MODELS.map((id) => ({ id, object: "model" })),
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
        reject(new Error("fake OpenAI did not get a port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/v1/responses`,
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
