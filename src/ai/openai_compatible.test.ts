import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAiBaseUrl, presetBaseUrl } from "./openai_compatible.ts";

const parsed = (raw: string, allowHttp = false) => {
  const result = parseAiBaseUrl(raw, { allowHttp });
  if (!result.ok) throw new Error(result.problem);
  return result.value;
};

test("a base URL is cleaned of a trailing slash and /chat/completions", () => {
  assert.equal(
    parsed("https://x.openai.azure.com/openai/v1/").endpoint,
    "https://x.openai.azure.com/openai/v1/chat/completions",
  );
  assert.equal(
    parsed("https://x.example/v1/chat/completions").base,
    "https://x.example/v1",
  );
  assert.equal(
    parsed("https://x.example").endpoint,
    "https://x.example/chat/completions",
  );
});

test("user info, a query, a fragment and other schemes are refused", () => {
  for (const raw of [
    "https://user:pw@x.example/v1",
    "https://x.example/v1?key=abc",
    "https://x.example/v1#a",
    "ftp://x.example/v1",
    "not a url",
  ]) {
    assert.equal(parseAiBaseUrl(raw).ok, false, raw);
  }
});

test("http is fine for this machine, needs a flag elsewhere, and is marked", () => {
  for (const raw of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:8000/v1",
    "http://[::1]:8000/v1",
  ]) {
    assert.equal(parsed(raw).plainRemote, false, raw);
  }
  assert.equal(parseAiBaseUrl("http://ollama:11434/v1").ok, false);
  assert.equal(parsed("http://ollama:11434/v1", true).plainRemote, true);
});

test("presets fill the address and check what they put in the host", () => {
  const ok = (preset: string, opts = {}) => {
    const result = presetBaseUrl(preset, opts);
    if (!result.ok) throw new Error(result.problem);
    return result.url;
  };
  assert.equal(
    ok("azure", { resource: "my-res" }),
    "https://my-res.openai.azure.com/openai/v1",
  );
  assert.equal(
    ok("bedrock", { region: "us-east-1" }),
    "https://bedrock-mantle.us-east-1.api.aws/v1",
  );
  assert.equal(
    ok("gemini"),
    "https://generativelanguage.googleapis.com/v1beta/openai",
  );
  assert.equal(ok("ollama"), "http://localhost:11434/v1");
  assert.equal(
    presetBaseUrl("azure", { resource: "evil.example/x" }).ok,
    false,
  );
  assert.equal(presetBaseUrl("azure").ok, false);
  assert.equal(
    presetBaseUrl("bedrock", { region: "us-east-1.evil" }).ok,
    false,
  );
  assert.equal(presetBaseUrl("nope").ok, false);
});
