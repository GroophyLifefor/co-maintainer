import { test } from "node:test";
import { createServer } from "node:http";
import { deleteEnv, setEnv } from "../util/runtime.ts";
import { openCodeBase, openCodeHost, verifyOpenCode } from "./opencode.ts";
import { openRouterError } from "./openrouter.ts";

test("opencode: Zen and Go live under their own paths", () => {
  deleteEnv("CM_OPENCODE_URL");
  if (openCodeBase("opencode-zen") !== "https://opencode.ai/zen/v1") {
    throw new Error(openCodeBase("opencode-zen"));
  }
  if (openCodeBase("opencode-go") !== "https://opencode.ai/zen/go/v1") {
    throw new Error(openCodeBase("opencode-go"));
  }
  const host = openCodeHost("opencode-go");
  if (host.endpoint !== "https://opencode.ai/zen/go/v1/chat/completions") {
    throw new Error(host.endpoint);
  }
});

test("opencode: errors name the gateway, not OpenRouter", () => {
  const host = openCodeHost("opencode-zen");
  const denied = openRouterError("m", 401, "{}", host);
  if (denied.code !== "opencode_unauthorized") throw new Error(denied.code);
  if (denied.message !== "OpenCode Zen rejected the API key.") {
    throw new Error(denied.message);
  }
  const unknown = openRouterError(
    "glm-x",
    400,
    JSON.stringify({ error: { message: "model glm-x not supported" } }),
    host,
  );
  if (unknown.code !== "opencode_unknown_model") throw new Error(unknown.code);
  if (!/Chat Completions/.test(unknown.hint ?? "")) {
    throw new Error(`the hint should say why: ${unknown.hint}`);
  }
});

test("opencode: set checks the model against the public list", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "kimi-k3" }] }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("port");
  setEnv("CM_OPENCODE_URL", `http://127.0.0.1:${address.port}`);
  try {
    const known = await verifyOpenCode("opencode-go", "k", "kimi-k3");
    if (known.status !== "ok") throw new Error(JSON.stringify(known));
    const unknown = await verifyOpenCode("opencode-go", "k", "nope");
    if (unknown.status !== "rejected") throw new Error(JSON.stringify(unknown));
    if (unknown.error.message !== "OpenCode Go does not know the model nope.") {
      throw new Error(unknown.error.message);
    }
  } finally {
    deleteEnv("CM_OPENCODE_URL");
    await new Promise<void>((done) => server.close(() => done()));
  }
});
