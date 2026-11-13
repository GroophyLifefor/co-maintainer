/** After Ctrl-C a batch stops instead of dropping its units.
 *
 * A batch drops a unit whose calls keep failing and the run goes on. After
 * Ctrl-C every call fails at once, so `review --sync` would have gone on to
 * write guides with every section dropped. */
import { test } from "node:test";
import { AiBatch } from "./batch.ts";
import { armInterrupt, disarmInterrupt } from "../util/interrupt.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import type { AiProvider, AiResponse } from "../types.ts";

class AbortedProvider implements AiProvider {
  calls = 0;
  complete(): Promise<AiResponse> {
    this.calls++;
    return Promise.reject(new DOMException("aborted", "AbortError"));
  }
}

test("an interrupted batch throws at once instead of dropping the unit", async () => {
  const names = ["XDG_CACHE_HOME", "LOCALAPPDATA", "HOME"] as const;
  const original = names.map((name) => getEnv(name));
  const home = tempDirSync();
  // The batch caches its units in cache.db. Keep it out of the real cache.
  setEnv("XDG_CACHE_HOME", `${home}/cache`);
  setEnv("LOCALAPPDATA", `${home}/cache`);
  setEnv("HOME", home);
  const controller = armInterrupt();
  try {
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
  } finally {
    disarmInterrupt();
    names.forEach((name, index) => {
      const value = original[index];
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    });
  }
});
