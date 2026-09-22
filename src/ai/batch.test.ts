import { AiBatch } from "./batch.ts";
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

const REQUEST: AiRequest = { job: "extract_unit", prompt: "p", maxTokens: 10 };

test("a unit whose output does not parse is retried once and then cached", async () => {
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
    if (!results[0] || queue.skippedUnits().length !== 0) {
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

test("a unit that never parses is skipped and left uncached", async () => {
  const repo = `batch-skip-${crypto.randomUUID()}`;
  const provider = new FlakyProvider(Number.POSITIVE_INFINITY);
  const queue = new AiBatch(provider, repo, 1, "mock:v2", () => "not JSON");
  try {
    const results = await queue.run([{ ...REQUEST }]);
    if (results[0] !== undefined) {
      throw new Error("a skipped unit still returned a response");
    }
    if (provider.calls !== 2) {
      throw new Error(`expected two attempts, got ${provider.calls}`);
    }
    const skipped = queue.skippedUnits();
    if (skipped.length !== 1 || skipped[0].reason !== "not JSON") {
      throw new Error(`skipped: ${JSON.stringify(skipped)}`);
    }
    // Nothing was cached: a fresh batch calls the provider again rather than
    // replaying the unusable output.
    const second = new FlakyProvider(Number.POSITIVE_INFINITY);
    const secondQueue = new AiBatch(
      second,
      repo,
      1,
      "mock:v2",
      () => "not JSON",
    );
    await secondQueue.run([{ ...REQUEST }]);
    if (second.calls === 0) {
      throw new Error("the skipped unit was cached anyway");
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
    if (!results[0] || second.skippedUnits().length !== 0) {
      throw new Error("the poisoned record was not replaced");
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});
