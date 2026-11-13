/** After Ctrl-C a batch stops instead of dropping its units.
 *
 * A batch drops a unit whose calls keep failing and the run goes on. After
 * Ctrl-C every call fails at once, so `review --sync` would have gone on to
 * write guides with every section dropped. */
import { test } from "node:test";
import { AiBatch } from "./batch.ts";
import { armInterrupt, disarmInterrupt } from "../util/interrupt.ts";
import { offlineEnv } from "../testing/offline_env.ts";
import { removePath, tempDir } from "../testing/runtime.ts";
import type { AiProvider, AiResponse } from "../types.ts";

class AbortedProvider implements AiProvider {
  calls = 0;
  complete(): Promise<AiResponse> {
    this.calls++;
    return Promise.reject(new DOMException("aborted", "AbortError"));
  }
}

/** Runs `fn` with cache.db in a temp directory and an armed interrupt. */
async function interruptible(
  fn: (controller: AbortController) => Promise<void>,
): Promise<void> {
  const dir = await tempDir({ prefix: "cm-batch-" });
  const offline = offlineEnv(dir);
  const controller = armInterrupt();
  try {
    await fn(controller);
  } finally {
    disarmInterrupt();
    offline.restore();
    await removePath(dir, { recursive: true });
  }
}

test("an interrupted batch throws at once instead of dropping the unit", async () => {
  await interruptible(async (controller) => {
    controller.abort();
    const provider = new AbortedProvider();
    const queue = new AiBatch(provider, "acme/app", 1, "mock:v1");
    let threw = false;
    try {
      await queue.run([{ job: "test", prompt: "p", maxTokens: 10 }]);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("the interrupted batch went on without it");
    if (provider.calls !== 1) {
      throw new Error(`${provider.calls} calls, want 1 with no retry`);
    }
  });
});
