/** The optional `ChatHost` fields the openai-compatible provider uses. With
 * none of them set, the provider behaves as OpenRouter always has. */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { type ChatHost, OpenRouterProvider } from "./openrouter.ts";
import { parseChatResponse } from "./provider.ts";
import { CliError } from "../cli/error.ts";
import { isolateTestFile } from "../testing/locations.ts";

isolateTestFile();

type Seen = { headers: IncomingMessage["headers"]; body: string };

async function serve(
  answer: (seen: Seen) => {
    status: number;
    body: string;
    headers?: Record<string, string>;
  },
) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const entry = { headers: req.headers, body };
      seen.push(entry);
      const reply = answer(entry);
      res.writeHead(reply.status, {
        "content-type": "application/json",
        ...reply.headers,
      });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  return {
    url,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const OK = JSON.stringify({
  choices: [{ message: { content: "ok" } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

function host(endpoint: string, extra: Partial<ChatHost> = {}): ChatHost {
  return {
    provider: "openrouter",
    name: "Test host",
    code: "test",
    endpoint,
    headers: {},
    modelHint: "pick another",
    ...extra,
  };
}

test("an empty key is allowed only when the host says so, and then no auth header is sent", async () => {
  const server = await serve(() => ({ status: 200, body: OK }));
  try {
    assert.throws(() => new OpenRouterProvider("", "m", host(server.url)));
    const provider = new OpenRouterProvider(
      "",
      "m",
      host(server.url, { keyOptional: true }),
    );
    await provider.complete({ prompt: "hi", maxTokens: 10, job: "t" });
    assert.equal(server.seen[0]!.headers.authorization, undefined);
    const withheld = new OpenRouterProvider(
      "secret",
      "m",
      host(server.url, { sendKey: false }),
    );
    await withheld.complete({ prompt: "hi", maxTokens: 10, job: "t" });
    assert.equal(server.seen[1]!.headers.authorization, undefined);
  } finally {
    await server.close();
  }
});

test("a 404 reads as an unknown model when the host says so, and a non-JSON body is not shown", async () => {
  const server = await serve(() => ({
    status: 404,
    body: "<html>secret page</html>",
  }));
  try {
    const provider = new OpenRouterProvider(
      "k",
      "gpt-x",
      host(server.url, {
        notFoundIsUnknownModel: true,
        jsonErrorOnly: true,
        keyHint: "use --ai-key",
      }),
    );
    await assert.rejects(
      provider.complete({ prompt: "hi", maxTokens: 10, job: "t" }),
      (error) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "test_unknown_model");
        assert.ok(!error.message.includes("secret page"));
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("a redirect is refused when the host asks for redirect: error", async () => {
  const server = await serve(() => ({
    status: 302,
    body: "",
    headers: { location: "http://example.invalid/" },
  }));
  try {
    const provider = new OpenRouterProvider(
      "k",
      "m",
      host(server.url, { init: () => ({ redirect: "error" }) }),
    );
    await assert.rejects(
      provider.complete({ prompt: "hi", maxTokens: 10, job: "t" }),
      (error) => error instanceof CliError && error.code === "test_redirect",
    );
  } finally {
    await server.close();
  }
});

test("a tool call with no id gets one, so the next turn can answer it", () => {
  const response = parseChatResponse(
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              { type: "function", function: { name: "ping", arguments: "{}" } },
            ],
          },
        },
      ],
    },
    "openrouter",
    "m",
  );
  assert.equal(response.toolCalls?.length, 1);
  assert.ok(response.toolCalls![0]!.id.length > 0);
});
