import { AiBatch, retryDelayMs } from "./batch.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import { test } from "node:test";

class MockProvider implements AiProvider {
  calls = 0;
  active = 0;
  peak = 0;

  async complete(request: AiRequest): Promise<AiResponse> {
    this.calls++;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.active--;
    return {
      text: `result:${request.prompt}`,
      tokensIn: 1,
      tokensOut: 1,
      model: "mock",
      provider: "openrouter",
    };
  }
}

test("AI queue limits concurrency and resumes from disk", async () => {
  const repo = `queue-test-${crypto.randomUUID()}`;
  const requests = Array.from({ length: 5 }, (_, index) => ({
    job: "test",
    prompt: `prompt-${index}`,
    maxTokens: 10,
  }));
  try {
    const firstProvider = new MockProvider();
    const firstQueue = new AiBatch(firstProvider, repo, 3, "mock:v1");
    const first = await firstQueue.run(requests);
    if (first.filter(Boolean).length !== 5) {
      throw new Error("not all jobs completed");
    }
    if (firstProvider.peak > 3) throw new Error("queue exceeded concurrency");
    if (firstProvider.calls !== 5) {
      throw new Error("unexpected first call count");
    }

    const secondProvider = new MockProvider();
    const secondQueue = new AiBatch(secondProvider, repo, 3, "mock:v1");
    const second = await secondQueue.run(requests);
    if (second.filter(Boolean).length !== 5) {
      throw new Error("cached jobs missing");
    }
    if (secondProvider.calls !== 0) {
      throw new Error("cached jobs were called again");
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});

/** Fails the first `N` calls with text that does not validate, then succeeds.
 * The attempt counter is shared across requests, so the tests below use a
 * single request to keep the sequence predictable. */
class FlakyProvider implements AiProvider {
  calls = 0;
  private readonly badCalls: number;
  constructor(badCalls: number) {
    this.badCalls = badCalls;
  }
  async complete(request: AiRequest): Promise<AiResponse> {
    this.calls++;
    return {
      text:
        this.calls <= this.badCalls ? "not json" : `result:${request.prompt}`,
      tokensIn: 1,
      tokensOut: 1,
      model: "mock",
      provider: "openrouter",
    };
  }
}

/** Throws on every call, to exercise the provider-error path. */
class ErrorProvider implements AiProvider {
  calls = 0;
  async complete(): Promise<AiResponse> {
    this.calls++;
    throw new Error("connection reset");
  }
}

const REQUEST: AiRequest = { job: "extract_unit", prompt: "p", maxTokens: 10 };

test("a rate limit waits before the retry, other failures do not", () => {
  const limited = "OpenRouter failed with 429: Provider returned error";
  if (retryDelayMs(limited, 1) !== 5_000) {
    throw new Error(`first backoff: ${retryDelayMs(limited, 1)}`);
  }
  if (retryDelayMs(limited, 2) !== 15_000) {
    throw new Error(`second backoff: ${retryDelayMs(limited, 2)}`);
  }
  if (retryDelayMs("connection reset", 1) !== 0) {
    throw new Error("a non-rate-limit failure must retry immediately");
  }
});

test("a unit whose output does not parse is retried and then cached", async () => {
  const repo = `batch-retry-${crypto.randomUUID()}`;
  // One bad call: the first attempt fails validation, the retry succeeds.
  const provider = new FlakyProvider(1);
  const queue = new AiBatch(
    provider,
    repo,
    1,
    "mock:v2",
    (_request, response) =>
      response.text.startsWith("result:") ? null : "not JSON",
  );
  try {
    const results = await queue.run([{ ...REQUEST }]);
    if (provider.calls !== 2) {
      throw new Error(`expected one retry, got ${provider.calls} calls`);
    }
    if (!results[0]) {
      throw new Error("the retry did not produce a usable result");
    }
    // The good retry is cached, so a second batch needs no provider call.
    const second = new FlakyProvider(0);
    const secondQueue = new AiBatch(second, repo, 1, "mock:v2", () => null);
    await secondQueue.run([{ ...REQUEST }]);
    if (second.calls !== 0) {
      throw new Error("the retried result was not cached");
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});

test("a unit that never parses does not fail the run", async () => {
  const repo = `batch-fail-${crypto.randomUUID()}`;
  const provider = new FlakyProvider(Number.POSITIVE_INFINITY);
  const queue = new AiBatch(provider, repo, 1, "mock:v2", () => "not JSON");
  try {
    const results = await queue.run([{ ...REQUEST }]);
    if (provider.calls !== 3) {
      throw new Error(`expected three attempts, got ${provider.calls}`);
    }
    // The response never met its contract: the unit is dropped, not cached, so
    // a later run retries it, and the run itself does not fail.
    if (results[0] !== undefined) {
      throw new Error("an unusable unit was kept");
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});

test("a provider error does not fail the run", async () => {
  const repo = `batch-error-${crypto.randomUUID()}`;
  const provider = new ErrorProvider();
  const queue = new AiBatch(provider, repo, 1, "mock:v2");
  try {
    const results = await queue.run([{ ...REQUEST }]);
    if (provider.calls !== 3) {
      throw new Error(`expected three attempts, got ${provider.calls}`);
    }
    // The unit is dropped, not thrown: the run keeps its other work.
    if (results[0] !== undefined) {
      throw new Error("a failed unit produced a result");
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});

test("an unusable cache record from an earlier version is dropped and retried", async () => {
  const repo = `batch-poison-${crypto.randomUUID()}`;
  // First run has no validator, so it caches output that a validator would
  // reject: this stands in for a 0.4.x record.
  const noCheck = new FlakyProvider(Number.POSITIVE_INFINITY);
  const first = new AiBatch(noCheck, repo, 1, "mock:v2");
  try {
    await first.run([{ ...REQUEST }]);
    // Second run validates. It must not accept the cached bad record; it drops
    // it and re-asks the provider, which now answers with valid text.
    const good = new FlakyProvider(0);
    const second = new AiBatch(
      good,
      repo,
      1,
      "mock:v2",
      (_request, response) =>
        response.text.startsWith("result:") ? null : "not JSON",
    );
    const results = await second.run([{ ...REQUEST }]);
    if (good.calls !== 1) {
      throw new Error(`expected one provider call, got ${good.calls}`);
    }
    if (!results[0]) {
      throw new Error("the poisoned record was not replaced");
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});
