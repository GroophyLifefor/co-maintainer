import { githubFetch, paginate } from "./client.ts";

function response(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response("{}", { status, headers });
}

Deno.test("a secondary rate limit is retried and then succeeds", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return calls === 1
        ? response(403, { "retry-after": "0" })
        : response(200);
    };
    const result = await githubFetch("https://api.github.com/x", {});
    if (result.status !== 200) throw new Error("did not retry to success");
    if (calls !== 2) throw new Error(`expected 2 calls, got ${calls}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a primary rate limit at zero remaining fails immediately", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    const resetAt = Math.floor(Date.now() / 1000) + 3600;
    globalThis.fetch = async () => {
      calls++;
      return response(403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetAt),
      });
    };
    let threw = false;
    try {
      await githubFetch("https://api.github.com/x", {});
    } catch (error) {
      threw = true;
      if (!String(error).includes("rate limit")) {
        throw new Error("error did not mention the rate limit");
      }
    }
    if (!threw) throw new Error("expected the primary limit to throw");
    if (calls !== 1) {
      throw new Error(`expected exactly one call, got ${calls}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("paginate stops at a short page and respects a limit", async () => {
  const pages: Record<number, number[]> = {
    1: Array.from({ length: 100 }, (_, i) => i),
    2: [100, 101],
  };
  const items = await paginate<number>(
    async (endpoint) => {
      const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1]);
      return pages[page] ?? [];
    },
    "items",
  );
  if (items.length !== 102) {
    throw new Error(`expected 102 items, got ${items.length}`);
  }

  const limited = await paginate<number>(
    async (endpoint) => {
      const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1]);
      return pages[page] ?? [];
    },
    "items",
    10,
  );
  if (limited.length !== 10) {
    throw new Error(`expected the limit to cap at 10, got ${limited.length}`);
  }
});
