/** The guide prompts must stay exactly what 0.6.13 sent.
 *
 * The AI cache is keyed by the request text, so any change to the guide
 * prompt makes every repository pay for a new guide on its next `sync`.
 * `guide_prompts_main.json` is a fixed copy of the `synth_guide` and
 * `synth_guide_short` requests origin/main builds for `PIN_FACTS`. A guide
 * prompt change belongs in its own branch, measured before it is merged. */
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { synthesizeReviewGuides } from "./guide.ts";
import {
  PIN_FACTS,
  PIN_LONG_GUIDE,
} from "../testing/fixtures/guide_prompts_input.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  readTextFile,
  remove,
  setEnv,
} from "../util/runtime.ts";
import { withLogSink } from "../util/log.ts";
import { isolateTestFile } from "../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../testing/fixtures/guide_prompts_main.json",
);

class Recorder implements AiProvider {
  requests: AiRequest[] = [];
  async complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(request);
    return {
      text: PIN_LONG_GUIDE,
      tokensIn: 1,
      tokensOut: 1,
      model: "fixture",
      provider: "openrouter",
    };
  }
}

test("the guide requests are byte for byte the ones origin/main builds", async () => {
  const root = await makeTempDir({ prefix: "cm-guide-pin-" });
  const previous = getEnv("XDG_CACHE_HOME");
  setEnv("XDG_CACHE_HOME", root);
  try {
    const provider = new Recorder();
    await withLogSink(
      () => {},
      () =>
        synthesizeReviewGuides(
          provider,
          `guide-pin-${crypto.randomUUID()}`,
          "openrouter",
          "fixture",
          1,
          PIN_FACTS,
        ),
    );
    const want = JSON.parse(await readTextFile(fixture)) as AiRequest[];
    const got = provider.requests.map(({ job, system, prompt, maxTokens }) => ({
      job,
      system,
      prompt,
      maxTokens,
    }));
    if (got.length !== want.length) {
      throw new Error(`${got.length} requests, want ${want.length}`);
    }
    for (let index = 0; index < want.length; index++) {
      for (const field of ["job", "system", "prompt", "maxTokens"] as const) {
        if (got[index][field] !== want[index][field]) {
          throw new Error(
            `${want[index].job} ${field} differs from origin/main:\n${String(got[index][field])}`,
          );
        }
      }
    }
  } finally {
    if (previous === undefined) deleteEnv("XDG_CACHE_HOME");
    else setEnv("XDG_CACHE_HOME", previous);
    await remove(root, { recursive: true });
  }
});
