import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { readConfig, writeUserConfig } from "../../config.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { isolateTestFile } from "../../testing/locations.ts";
import { runSet } from "./set.ts";

isolateTestFile();

async function withSandbox(fn: () => Promise<void>): Promise<void> {
  const original = getEnv("CM_CONFIG_PATH");
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  try {
    await fn();
  } finally {
    if (original === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", original);
    await removePath(dir, { recursive: true }).catch(() => {});
  }
}

test("a preset fills the base URL and picks openai-compatible", async () => {
  await withSandbox(async () => {
    await runSet(["--ai-preset=azure", "--ai-resource=my-res", "--no-verify"]);
    const config = readConfig();
    assert.equal(config.ai, "openai-compatible");
    assert.equal(config.aiBaseUrl, "https://my-res.openai.azure.com/openai/v1");
  });
});

test("a new base URL drops the saved key and what the old server taught", async () => {
  await withSandbox(async () => {
    await writeUserConfig({
      ai: "openai-compatible",
      aiBaseUrl: "https://one.example/v1",
      token: "old-key",
      aiModelQuirks: { m: { drop: ["temperature"] } },
    });
    await runSet(["--ai-base-url=https://two.example/v1", "--no-verify"]);
    const config = readConfig();
    assert.equal(config.aiBaseUrl, "https://two.example/v1");
    assert.equal(config.token, undefined);
    assert.equal(config.aiModelQuirks, undefined);
    await runSet([
      "--ai-base-url=https://three.example/v1",
      "--ai-key=new-key",
      "--no-verify",
    ]);
    assert.equal(readConfig().token, "new-key");
  });
});

test("switching to openai-compatible drops another provider's key instead of sending it", async () => {
  await withSandbox(async () => {
    await writeUserConfig({ ai: "openrouter", token: "openrouter-key" });
    await runSet(["--ai-base-url=http://localhost:11434/v1", "--no-verify"]);
    const config = readConfig();
    assert.equal(config.ai, "openai-compatible");
    assert.equal(config.token, undefined);
  });
});

test("set checks the server, and a model that refuses tools is saved as such", async () => {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (JSON.parse(raw).tools) {
        res.statusCode = 400;
        return res.end(
          JSON.stringify({
            error: { message: "tools are not supported by this model" },
          }),
        );
      }
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    await withSandbox(async () => {
      await runSet([
        `--ai-base-url=${base}`,
        "--low-model=small",
        "--high-model=big",
      ]);
      assert.equal(readConfig().aiModelQuirks?.big?.tools, false);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("bad addresses and a preset with a base URL are refused", async () => {
  await withSandbox(async () => {
    for (const args of [
      ["--ai-base-url=https://u:p@x.example/v1"],
      ["--ai-base-url=http://remote.example/v1"],
      ["--ai-preset=azure"],
      ["--ai-preset=gemini", "--ai-base-url=https://x.example/v1"],
    ]) {
      await assert.rejects(runSet([...args, "--no-verify"]), String(args));
    }
  });
});
