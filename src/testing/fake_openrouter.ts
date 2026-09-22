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
  | "bad-json";

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
    case "bad-json":
      return { status: 200, body: "not json at all" };
    case "success":
    case "timeout":
    default:
      return { status: 200, body: JSON.stringify(CHAT_RESPONSE) };
  }
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
      const { status, body } = reply(mode);
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
