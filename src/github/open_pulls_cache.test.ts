import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cachedOpenPulls,
  cachedOpenPullTitle,
  clearOpenPullsCache,
  OPEN_PULLS_TTL_MS,
} from "./open_pulls_cache.ts";
import { TEST_PKCS1_PEM } from "../testing/fixtures/rsa_key.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A fake GitHub that counts every call it answers. */
async function withGithub(
  fn: (calls: string[]) => Promise<void>,
): Promise<void> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (
      url.endsWith("/app/installations") ||
      url.includes("/app/installations?")
    ) {
      return jsonResponse([
        { id: 7, account: { login: "acme", type: "Organization" } },
      ]);
    }
    if (url.includes("/access_tokens")) {
      return jsonResponse({
        token: "ghs_cache_test",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (url.includes("/installation/repositories")) {
      return jsonResponse({
        repositories: [{ full_name: "acme/widgets", private: false }],
      });
    }
    if (url.includes("/repos/acme/widgets/pulls")) {
      return jsonResponse([
        {
          number: 12,
          title: "Tidy the helper",
          draft: false,
          user: { login: "octocat" },
          head: { ref: "fix/helper" },
          updated_at: "2026-09-22T10:00:00Z",
        },
      ]);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  clearOpenPullsCache();
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
    clearOpenPullsCache();
  }
}

test("a second visit within a minute makes no GitHub call", async () => {
  await withGithub(async (calls) => {
    const first = await cachedOpenPulls("1", TEST_PKCS1_PEM, "acme/widgets");
    assert.equal(first?.[0]?.number, 12);
    assert.ok(calls.length > 0, "the first visit asks GitHub");
    const before = calls.length;
    const second = await cachedOpenPulls("1", TEST_PKCS1_PEM, "acme/widgets");
    assert.deepEqual(second, first);
    assert.equal(calls.length, before, "the second visit asked GitHub");
    assert.equal(cachedOpenPullTitle("acme/widgets", 12), "Tidy the helper");
  });
});

test("after a minute only the open list is fetched again", async () => {
  await withGithub(async (calls) => {
    let now = 1_000_000;
    await cachedOpenPulls("1", TEST_PKCS1_PEM, "acme/widgets", () => now);
    const before = calls.length;
    now += OPEN_PULLS_TTL_MS + 1;
    await cachedOpenPulls("1", TEST_PKCS1_PEM, "acme/widgets", () => now);
    const again = calls.slice(before);
    assert.equal(again.length, 1, `expected one call, got ${again.join(", ")}`);
    assert.match(again[0]!, /\/repos\/acme\/widgets\/pulls/);
  });
});

test("a repository no installation covers is remembered for a minute", async () => {
  await withGithub(async (calls) => {
    const first = await cachedOpenPulls("1", TEST_PKCS1_PEM, "other/repo");
    assert.equal(first, undefined);
    const before = calls.length;
    await cachedOpenPulls("1", TEST_PKCS1_PEM, "other/repo");
    assert.equal(calls.length, before);
  });
});
