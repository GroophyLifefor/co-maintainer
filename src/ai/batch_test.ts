import { AiBatch } from "./batch.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";

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

Deno.test("AI queue limits concurrency and resumes from disk", async () => {
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
