import { AiBatch } from "./batch.ts";
import { OutputLimitError } from "./output_limit.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import { test } from "node:test";
import { isolateTestFile } from "../testing/locations.ts";

isolateTestFile();

/** `cut-valid` is an answer the validator accepts although the limit cut it. */
type Step = "limit" | "cut" | "cut-valid" | "error" | "ok";

/** Answers each call with the next step and records the limit it was sent. */
class StepProvider implements AiProvider {
  limits: number[] = [];
  private readonly steps: Step[];
  constructor(steps: Step[]) {
    this.steps = steps;
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    this.limits.push(request.maxTokens);
    const step = this.steps[this.limits.length - 1] ?? "ok";
    if (step === "limit")
      throw new OutputLimitError("reached its output limit");
    if (step === "error") throw new Error("server error 500");
    return {
      text: step === "cut" ? "[{" : "[]",
      ...(step === "cut" || step === "cut-valid"
        ? { cutOff: true as const }
        : {}),
      tokensIn: 1,
      tokensOut: 1,
      model: "mock",
      provider: "openrouter",
    };
  }
}

const validate = (_: AiRequest, response: AiResponse) =>
  response.text === "[]" ? null : "not a JSON array";

type Run = { limits: number[]; result: AiResponse | undefined };

/** Runs one request through a batch of its own repository, then `check`, and
 * removes the repository's cache records whatever either of them throws. */
async function run(
  steps: Step[],
  growOnCutOff: boolean,
  check: (run: Run, repo: string, request: AiRequest) => Promise<void> | void,
): Promise<void> {
  const repo = `cut-off-${crypto.randomUUID()}`;
  const request: AiRequest = {
    job: "extract_unit",
    prompt: `p-${crypto.randomUUID()}`,
    maxTokens: 8_000,
    ...(growOnCutOff ? { growOnCutOff: true } : {}),
  };
  try {
    const provider = new StepProvider(steps);
    const [result] = await new AiBatch(
      provider,
      repo,
      1,
      "mock:v1",
      validate,
    ).run([request]);
    await check({ limits: provider.limits, result }, repo, request);
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
}

function expectLimits(actual: number[], expected: number[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `limits ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

test("an empty answer at the output limit retries with 16k, then 32k, then skips", async () => {
  await run(["limit", "limit", "limit"], true, ({ limits, result }) => {
    expectLimits(limits, [8_000, 16_000, 32_000]);
    if (result !== undefined) throw new Error("unit was not skipped");
  });
});

test("a cut answer the validator rejects retries with twice the limit", async () => {
  await run(["cut", "ok"], true, ({ limits, result }) => {
    expectLimits(limits, [8_000, 16_000]);
    if (result?.text !== "[]") throw new Error("retry answer not used");
  });
});

test("a retry that succeeds with a larger limit is cached under the original request", async () => {
  await run(["limit", "ok"], true, async (_, repo, request) => {
    const again = new StepProvider([]);
    const [cached] = await new AiBatch(again, repo, 1, "mock:v1", validate).run(
      [request],
    );
    if (again.limits.length !== 0)
      throw new Error("cached answer was asked again");
    if (cached?.text !== "[]") throw new Error("cached answer missing");
  });
});

test("other failures retry with the same limit", async () => {
  await run(["error", "ok"], true, ({ limits }) => {
    expectLimits(limits, [8_000, 8_000]);
  });
});

test("a request without growOnCutOff keeps its limit", async () => {
  await run(["limit", "cut", "ok"], false, ({ limits }) => {
    expectLimits(limits, [8_000, 8_000, 8_000]);
  });
});

test("a cut answer the validator accepts still retries with twice the limit", async () => {
  await run(["cut-valid", "ok"], true, ({ limits, result }) => {
    expectLimits(limits, [8_000, 16_000]);
    if (result?.cutOff) throw new Error("the cut answer was kept");
  });
});

test("a cut answer that validates on the last try is kept", async () => {
  await run(
    ["cut-valid", "cut-valid", "cut-valid"],
    true,
    ({ limits, result }) => {
      expectLimits(limits, [8_000, 16_000, 32_000]);
      if (!result?.cutOff) throw new Error("the last answer was not kept");
    },
  );
});

test("a cut answer that validates is kept when the request does not grow", async () => {
  await run(["cut-valid"], false, ({ limits, result }) => {
    expectLimits(limits, [8_000]);
    if (!result?.cutOff) throw new Error("the answer was not kept");
  });
});
