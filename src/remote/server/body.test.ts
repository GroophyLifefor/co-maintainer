import { readBoundedJson, readBoundedUtf8 } from "./body.ts";
import { test } from "node:test";

test("readBoundedUtf8 enforces byte limit while streaming", async () => {
  const over = new Uint8Array(1025);
  over.fill(97);
  const request = new Request("http://localhost/", {
    method: "POST",
    body: over,
  });
  const result = await readBoundedUtf8(request, 1024);
  if (result.ok || result.reason !== "too_large") {
    throw new Error(`expected too_large, got ${JSON.stringify(result)}`);
  }
});

test("readBoundedUtf8 rejects declared Content-Length over limit", async () => {
  const request = new Request("http://localhost/", {
    method: "POST",
    headers: { "content-length": "999999" },
    body: "{}",
  });
  const result = await readBoundedUtf8(request, 100);
  if (result.ok || result.reason !== "too_large") {
    throw new Error("expected early reject from Content-Length");
  }
});

test("readBoundedJson parses UTF-8 JSON within limit", async () => {
  const request = new Request("http://localhost/", {
    method: "POST",
    body: '{"schemaVersion":1}',
  });
  const result = await readBoundedJson(request, 1024);
  if (!result.ok) throw new Error(JSON.stringify(result));
  const value = result.value as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error("parse failed");
});
