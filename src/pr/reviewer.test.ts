import {
  clampImproveMatrix,
  clampToolRounds,
  modelSummary,
} from "./reviewer.ts";
import { test } from "node:test";
import type { Options } from "../types.ts";

function contains(haystack: string, needle: string, what: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${what}: ${JSON.stringify(haystack)} lacks ${needle}`);
  }
}

test("modelSummary names the provider and both models", () => {
  const options = {
    ai: "openrouter",
    lowModel: "low/model",
    highModel: "high/model",
  } as unknown as Options;
  contains(
    modelSummary(options),
    "provider=openrouter · low=low/model · high=high/model",
    "summary",
  );
});

test("modelSummary says unset when a model is missing", () => {
  const options = { ai: "none" } as unknown as Options;
  contains(modelSummary(options), "low=unset", "low");
  contains(modelSummary(options), "high=unset", "high");
});

test("clampToolRounds scales with diff size but never runs away", () => {
  if (clampToolRounds(0) !== 4) throw new Error("small diff should stay at 4");
  if (clampToolRounds(200) !== 6) {
    throw new Error("expected 4 + 200/100 = 6");
  }
  if (clampToolRounds(100_000) !== 8) {
    throw new Error("a huge diff must still be capped at 8");
  }
});

test("clampImproveMatrix stays within 1 and 4", () => {
  if (clampImproveMatrix(0) !== 1) throw new Error("must not go below 1");
  if (clampImproveMatrix(2) !== 2) {
    throw new Error("a normal value passes through");
  }
  if (clampImproveMatrix(10) !== 4) {
    throw new Error("must not exceed the provider's token budget");
  }
});
