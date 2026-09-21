import { mock, test } from "node:test";
import {
  githubFetch,
  paginate,
  probeDelay,
  RATE_LIMIT_PROBE_MS,
} from "./client.ts";
import { quotaLine } from "./gh.ts";

function response(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response("{}", { status, headers });
}

function yieldToFetch(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

test("a secondary rate limit is retried and then succeeds", async () => {
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

test("a primary rate limit waits until reset and then retries", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    const resetAt = Math.floor(Date.now() / 1000) + 10 * 60;
    globalThis.fetch = async () => {
      calls++;
      return calls === 1
        ? response(403, {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetAt),
          })
        : response(200);
    };
    const pending = githubFetch("https://api.github.com/x", {});
    await yieldToFetch();
    mock.timers.tick(10 * 60 * 1000);
    const result = await pending;
    if (result.status !== 200) throw new Error("did not retry after the reset");
    if (calls !== 2) throw new Error(`expected 2 calls, got ${calls}`);
  } finally {
    globalThis.fetch = originalFetch;
    mock.timers.reset();
  }
});

test("a primary rate limit probes every 30 minutes before reset", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    const resetAt = Math.floor(Date.now() / 1000) + 45 * 60;
    globalThis.fetch = async () => {
      calls++;
      return calls < 3
        ? response(403, {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetAt),
          })
        : response(200);
    };
    const pending = githubFetch("https://api.github.com/x", {});
    await yieldToFetch();
    mock.timers.tick(RATE_LIMIT_PROBE_MS);
    await yieldToFetch();
    mock.timers.tick(15 * 60 * 1000);
    const result = await pending;
    if (result.status !== 200)
      throw new Error("did not succeed after the reset");
    if (calls !== 3) throw new Error(`expected 3 calls, got ${calls}`);
  } finally {
    globalThis.fetch = originalFetch;
    mock.timers.reset();
  }
});

test("probeDelay caps the wait at 30 minutes", () => {
  const now = 1_000_000;
  const ten = probeDelay(new Date(now + 10 * 60 * 1000), now);
  if (ten !== 10 * 60 * 1000) throw new Error(`expected 10m, got ${ten}`);
  const capped = probeDelay(new Date(now + 45 * 60 * 1000), now);
  if (capped !== RATE_LIMIT_PROBE_MS) {
    throw new Error(`expected 30m, got ${capped}`);
  }
  const past = probeDelay(new Date(now - 1000), now);
  if (past !== 0) throw new Error(`expected an immediate retry, got ${past}`);
  const invalid = probeDelay(new Date(Number.NaN), now);
  if (invalid !== RATE_LIMIT_PROBE_MS) {
    throw new Error(
      `expected a 30m probe for an invalid reset, got ${invalid}`,
    );
  }
});

test("quotaLine prints core, search, and the local reset clock", () => {
  const reset = 1_700_000_000;
  const date = new Date(reset * 1000);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const line = quotaLine({
    resources: {
      core: { limit: 5000, remaining: 4120, reset },
      search: { limit: 30, remaining: 28 },
    },
  });
  const expected = `github quota · core 4120/5000 · search 28/30 · reset ${hours}:${minutes}`;
  if (line !== expected) throw new Error(`unexpected quota line: ${line}`);
});

test("paginate stops at a short page and respects a limit", async () => {
  const pages: Record<number, number[]> = {
    1: Array.from({ length: 100 }, (_, i) => i),
    2: [100, 101],
  };
  const items = await paginate<number>(async (endpoint) => {
    const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1]);
    return pages[page] ?? [];
  }, "items");
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
