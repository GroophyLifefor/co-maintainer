/** Fake OpenRouter HTTP server for the CLI harness (CORE-03).
 *
 * A real server, not a stubbed `fetch`: the CLI spawns as its own process, so
 * the only way to intercept its calls is a socket it can reach. Point the CLI
 * at it with `CM_OPENROUTER_URL`.
 *
 * Modes are fixed at start: success, bad-model (400), unauthorized (401),
 * rate-limited (429), timeout (never answers), and bad-json (200 with a body
 * that is not the documented shape).
 */
import { createServer, type Server } from "node:http";

export type FakeOpenRouterMode =
  | "success"
  | "bad-model"
  | "unauthorized"
  | "rate-limited"
  | "timeout"
  | "bad-json"
  | "server-error"
  | "unknown-model";

export type FakeOpenRouter = {
  url: string;
  /** Every request body the CLI sent, in order. */
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
};

const CHAT_RESPONSE = {
  id: "fake-1",
  choices: [
    {
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "## Findings\n\nNo actionable findings.\n",
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 },
};

function reply(mode: FakeOpenRouterMode): { status: number; body: string } {
  switch (mode) {
    case "bad-model":
      return {
        status: 400,
        body: JSON.stringify({ error: { message: "model not found" } }),
      };
    case "unauthorized":
      return {
        status: 401,
        body: JSON.stringify({ error: { message: "Invalid API key" } }),
      };
    case "rate-limited":
      return {
        status: 429,
        body: JSON.stringify({ error: { message: "Rate limit exceeded" } }),
      };
    case "server-error":
      // A 5xx is a runtime failure the CLI cannot fix, so it must reach the top
      // level and exit 3 (CORE-11/CORE-12).
      return {
        status: 500,
        body: JSON.stringify({ error: { message: "internal error" } }),
      };
    case "bad-json":
      return { status: 200, body: "not json at all" };
    case "success":
    case "timeout":
    case "unknown-model":
    default:
      return { status: 200, body: JSON.stringify(CHAT_RESPONSE) };
  }
}

/** The models `config set` can verify against, with the prices the probe
 * estimate reads. The plainer names are what the config tests save, so a
 * `set --high-model=high/model` is accepted. */
const MODELS: { id: string; prompt: string; completion: string }[] = [
  { id: "fake/model", prompt: "0.0000005", completion: "0.0000015" },
  { id: "low/model", prompt: "0.0000002", completion: "0.0000006" },
  { id: "high/model", prompt: "0.000003", completion: "0.000009" },
  { id: "vendor/other", prompt: "0.000001", completion: "0.000002" },
];

/** Answers the `/key` and `/models` calls `config set` makes before writing
 * (CORE-22). A POST to the chat endpoint keeps using {@link reply}. */
function verifyReply(
  path: string,
  mode: FakeOpenRouterMode,
): { status: number; body: string } {
  if (mode === "unauthorized") return reply("unauthorized");
  if (mode === "timeout") return reply("success");
  if (path.endsWith("/key")) {
    return { status: 200, body: JSON.stringify({ data: { label: "fake" } }) };
  }
  const rows =
    mode === "unknown-model"
      ? MODELS.filter((model) => model.id !== "high/model")
      : MODELS;
  return {
    status: 200,
    body: JSON.stringify({
      data: rows.map((model) => ({
        id: model.id,
        pricing: { prompt: model.prompt, completion: model.completion },
      })),
    }),
  };
}

/** Starts the server on an ephemeral port and resolves once it is listening. */
export function startFakeOpenRouter(
  mode: FakeOpenRouterMode = "success",
): Promise<FakeOpenRouter> {
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      try {
        requests.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        requests.push({ __unparsed: raw });
      }
      if (mode === "timeout") return; // Leave the request hanging.
      // The verification calls are GETs to `/key` and `/models`; everything
      // else is the chat completion the review sends.
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const { status, body } =
        request.method === "GET" ? verifyReply(path, mode) : reply(mode);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fake OpenRouter did not get a port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/api/v1/chat/completions`,
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
