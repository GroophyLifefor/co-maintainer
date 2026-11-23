import { AiBatch } from "./batch.ts";
import { OutputLimitError } from "./output_limit.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import { test } from "node:test";
import { isolateTestFile } from "../testing/locations.ts";

isolateTestFile();

type Step = "limit" | "cut" | "error" | "ok";

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
      ...(step === "cut" ? { cutOff: true as const } : {}),
      tokensIn: 1,
      tokensOut: 1,
      model: "mock",
      provider: "openrouter",
    };
  }
}

const validate = (_: AiRequest, response: AiResponse) =>
  response.text === "[]" ? null : "not a JSON array";

function request(growOnCutOff: boolean): AiRequest {
  return {
    job: "extract_unit",
    prompt: `p-${crypto.randomUUID()}`,
    maxTokens: 8_000,
    ...(growOnCutOff ? { growOnCutOff: true } : {}),
  };
}

async function run(
  steps: Step[],
  growOnCutOff: boolean,
): Promise<{
  limits: number[];
  result: AiResponse | undefined;
  repo: string;
  req: AiRequest;
}> {
  const repo = `cut-off-${crypto.randomUUID()}`;
  const provider = new StepProvider(steps);
  const req = request(growOnCutOff);
  const [result] = await new AiBatch(
    provider,
    repo,
    1,
    "mock:v1",
    validate,
  ).run([req]);
  return { limits: provider.limits, result, repo, req };
}

function expectLimits(actual: number[], expected: number[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `limits ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

test("an empty answer at the output limit retries with 16k, then 32k, then skips", async () => {
  const { limits, result, repo } = await run(["limit", "limit", "limit"], true);
  try {
    expectLimits(limits, [8_000, 16_000, 32_000]);
    if (result !== undefined) throw new Error("unit was not skipped");
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});

test("a cut answer the validator rejects retries with twice the limit", async () => {
  const { limits, result, repo } = await run(["cut", "ok"], true);
  try {
    expectLimits(limits, [8_000, 16_000]);
    if (result?.text !== "[]") throw new Error("retry answer not used");
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});

test("a retry that succeeds with a larger limit is cached under the original request", async () => {
  const { repo, req } = await run(["limit", "ok"], true);
  try {
    const again = new StepProvider([]);
    const [cached] = await new AiBatch(again, repo, 1, "mock:v1", validate).run(
      [req],
    );
    if (again.limits.length !== 0)
      throw new Error("cached answer was asked again");
    if (cached?.text !== "[]") throw new Error("cached answer missing");
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});

test("other failures retry with the same limit", async () => {
  const { limits, repo } = await run(["error", "ok"], true);
  try {
    expectLimits(limits, [8_000, 8_000]);
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});

test("a request without growOnCutOff keeps its limit", async () => {
  const { limits, repo } = await run(["limit", "cut", "ok"], false);
  try {
    expectLimits(limits, [8_000, 8_000, 8_000]);
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});
