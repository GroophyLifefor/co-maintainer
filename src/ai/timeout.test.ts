/** The AI request timeout: 15 minutes unless the dashboard says otherwise,
 * and the limit really reaches `fetch`. Node's own limit is 300 seconds,
 * which a thinking model on a large pull request outlasted. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  aiDispatcher,
  aiTimeoutInit,
  aiTimeoutMs,
  DEFAULT_AI_TIMEOUT_MINUTES,
} from "./timeout.ts";
import { isolateTestFile } from "../testing/locations.ts";

// aiTimeoutInit reads the config. Keep it in a temp home, never the
// developer's real one.
isolateTestFile();

test("the default is 15 minutes", () => {
  assert.equal(DEFAULT_AI_TIMEOUT_MINUTES, 15);
  assert.equal(aiTimeoutMs({}), 15 * 60_000);
});

test("a saved timeout in minutes is used", () => {
  assert.equal(aiTimeoutMs({ aiTimeoutMinutes: 30 }), 30 * 60_000);
});

test("zero, a negative or a non number falls back to the default", () => {
  for (const value of [0, -5, Number.NaN, "20" as unknown as number]) {
    assert.equal(aiTimeoutMs({ aiTimeoutMinutes: value }), 15 * 60_000);
  }
});

test("one dispatcher per limit, a new one when the limit changes", () => {
  const first = aiDispatcher(60_000);
  assert.equal(aiDispatcher(60_000), first);
  assert.notEqual(aiDispatcher(120_000), first);
});

test("the fetch option carries the dispatcher for the configured limit", () => {
  const init = aiTimeoutInit() as unknown as { dispatcher: unknown };
  assert.equal(init.dispatcher, aiDispatcher(15 * 60_000));
});

test("fetch gives up after the dispatcher's limit, not Node's own", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end("late"), 1_000);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const init = { dispatcher: aiDispatcher(100) } as unknown as RequestInit;
    const error = await fetch(`http://127.0.0.1:${port}/`, init).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    assert.equal(
      (error as { cause?: { code?: string } } | undefined)?.cause?.code,
      "UND_ERR_HEADERS_TIMEOUT",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await aiDispatcher(60_000).close();
  }
});
