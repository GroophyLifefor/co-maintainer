/** Tests for the probe estimate, the reason text, and `--run`.
 *
 * The estimate is pure arithmetic over a price map, so it is tested directly.
 * Pricing and `--run` touch the network and the init path, so they run through
 * the fake OpenRouter and the CLI harness. */
import { test } from "node:test";
import {
  estimateCostLine,
  estimateInit,
  extractJobCount,
  readJobHistory,
} from "../ai/estimate.ts";
import type { Estimate } from "../ai/estimate.ts";
import { loadPrices } from "../ai/pricing.ts";
import type { ModelPrice } from "../ai/pricing.ts";
import { analyzeProbe } from "../knowledge/probe.ts";
import { cacheSet } from "../store/cache_db.ts";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";
import { sectionKeys } from "../knowledge/sections.ts";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  remove,
  setEnv,
} from "../util/runtime.ts";
import { isolateTestFile } from "../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

const PRICE: ModelPrice = { usdPerMillionIn: 1, usdPerMillionOut: 2 };

test("estimate: extract jobs are one per pull request plus the codebase read", () => {
  if (
    extractJobCount({
      pullRequests: 4,
      includeCodebase: true,
      includeHowRepoWorks: false,
    }) !== 5
  ) {
    throw new Error("4 PRs + codebase should be 5");
  }
  if (
    extractJobCount({
      pullRequests: 4,
      includeCodebase: false,
      includeHowRepoWorks: true,
    }) !== 5
  ) {
    throw new Error("4 PRs + documents should be 5");
  }
  if (
    extractJobCount({
      pullRequests: 0,
      includeCodebase: false,
      includeHowRepoWorks: false,
    }) !== 0
  ) {
    throw new Error("no sources should be 0 extract jobs");
  }
});

test("estimate: the calibrated run takes about what the calibration measured", () => {
  // The calibration run: 14 extract jobs, the sections and the two guide
  // jobs took about 85 s of AI time at --ai-concurrent=3, for $0.0664.
  const estimate = estimateInit({
    pullRequests: 13,
    includeCodebase: true,
    lowModel: "low",
    highModel: "high",
    prices: new Map([
      ["low", PRICE],
      ["high", PRICE],
    ]),
  });
  if (estimate.extract !== 14) throw new Error(`extract: ${estimate.extract}`);
  if (estimate.synth !== sectionKeys.length) {
    throw new Error(`synth: ${estimate.synth}`);
  }
  if (!(estimate.seconds[0] < 85 && estimate.seconds[1] > 85)) {
    throw new Error(`seconds: ${JSON.stringify(estimate.seconds)}`);
  }
  // With $1/$2 per million, the range is cents not dollars.
  if (!estimate.usd || estimate.usd[1] > 1) {
    throw new Error(`usd: ${JSON.stringify(estimate.usd)}`);
  }
  if (estimate.basis !== "calibration") {
    throw new Error(`basis: ${estimate.basis}`);
  }
  // More AI jobs at once shortens the time.
  const wide = estimateInit({
    pullRequests: 13,
    includeCodebase: true,
    prices: new Map(),
    aiConcurrent: 12,
  });
  if (!(wide.seconds[1] < estimate.seconds[1])) {
    throw new Error(`concurrency: ${wide.seconds} vs ${estimate.seconds}`);
  }
});

test("estimate: a known price for one model and not the other yields no dollars", () => {
  const estimate = estimateInit({
    pullRequests: 1,
    includeCodebase: true,
    lowModel: "low",
    highModel: "missing",
    prices: new Map([["low", PRICE]]),
  });
  if (estimate.usd !== undefined) {
    throw new Error(`usd should be absent: ${JSON.stringify(estimate.usd)}`);
  }
});

/** Isolates cache.db and repos under a temp dir for the duration of `fn`. */
async function withCacheDir<T>(fn: () => Promise<T>): Promise<T> {
  const root = await makeTempDir({ prefix: "cm-estimate-" });
  const saved = ["LOCALAPPDATA", "XDG_CACHE_HOME", "CM_OPENROUTER_URL"].map(
    (name) => [name, getEnv(name)] as const,
  );
  setEnv("LOCALAPPDATA", `${root}/localappdata`);
  setEnv("XDG_CACHE_HOME", `${root}/cache`);
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
    await remove(root, { recursive: true });
  }
}

test("estimate: recorded jobs for the repo replace the calibration", async () => {
  await withCacheDir(async () => {
    for (let index = 0; index < 5; index++) {
      await cacheSet(
        "cost",
        `acme/widgets:${index}`,
        JSON.stringify({
          at: new Date().toISOString(),
          job: "extract_unit",
          tokensIn: 1_000,
          tokensOut: 200,
          seconds: 3,
        }),
      );
    }
    const history = await readJobHistory("acme/widgets");
    if (!history) throw new Error("a 5-job history should count");
    if (history.tokensIn !== 1_000 || history.seconds !== 3) {
      throw new Error(`history: ${JSON.stringify(history)}`);
    }
    const estimate = estimateInit({
      pullRequests: 2,
      includeCodebase: false,
      lowModel: "low",
      highModel: "high",
      prices: new Map([
        ["low", PRICE],
        ["high", PRICE],
      ]),
      history,
    });
    if (estimate.basis !== "history") {
      throw new Error(`basis: ${estimate.basis}`);
    }
    // Recorded 3 s jobs are faster than the 5 s calibration.
    const calibrated = estimateInit({
      pullRequests: 2,
      includeCodebase: false,
      prices: new Map(),
    });
    if (!(estimate.seconds[1] < calibrated.seconds[1])) {
      throw new Error(
        `seconds from history: ${JSON.stringify(estimate.seconds)} vs ${JSON.stringify(calibrated.seconds)}`,
      );
    }
    // Another repo's jobs must not leak in.
    if (await readJobHistory("other/repo")) {
      throw new Error("another repo's jobs were counted");
    }
  });
});

test("pricing: reads the fake model list and caches it", async () => {
  const server = await startFakeOpenRouter("success");
  try {
    await withCacheDir(async () => {
      setEnv("CM_OPENROUTER_URL", server.url);
      const first = await loadPrices();
      if (first.source !== "network") {
        throw new Error(`first source: ${first.source}`);
      }
      if (!first.prices.has("high/model")) {
        throw new Error(`no price for high/model: ${[...first.prices.keys()]}`);
      }
      if (first.prices.get("high/model")?.usdPerMillionIn !== 3) {
        throw new Error(
          `price: ${JSON.stringify(first.prices.get("high/model"))}`,
        );
      }
      // The second read must come from cache, not the network.
      const second = await loadPrices();
      if (second.source !== "cache") {
        throw new Error(`second source: ${second.source}`);
      }
    });
  } finally {
    // A failed assertion must not leave the server holding the event loop
    // open, or the whole test file hangs instead of reporting the failure.
    await server.close();
  }
});

test("probe reasons: a healthy useful-commit ratio is not called noise", () => {
  // 8 commits, 5 useful: the old text claimed "mostly merge/noise", which the
  // numbers beside it contradicted.
  const commits = Array.from({ length: 8 }, (_, index) => ({
    commit: {
      message: index < 5 ? `feat: change ${index}` : `Merge branch ${index}`,
    },
    parents: index < 5 ? [{}] : [{}, {}],
  }));
  const analysis = analyzeProbe({}, [], [], commits);
  const noise = analysis.reasons.find((reason) =>
    reason.includes("merge/noise"),
  );
  if (noise) throw new Error(`called noise at 5/8 useful: ${noise}`);
  const short = analysis.reasons.find((reason) => reason.includes("short"));
  if (!short)
    throw new Error(`expected a short-history reason: ${analysis.reasons}`);
});

test("probe reasons: a genuinely noisy history is called noise", () => {
  const commits = Array.from({ length: 20 }, (_, index) => ({
    commit: {
      message: index < 5 ? `feat: change ${index}` : `Merge branch ${index}`,
    },
    parents: index < 5 ? [{}] : [{}, {}],
  }));
  const analysis = analyzeProbe({}, [], [], commits);
  const noise = analysis.reasons.find((reason) =>
    reason.includes("merge/noise"),
  );
  if (!noise)
    throw new Error(`expected noise at 5/20 useful: ${analysis.reasons}`);
});

function estimateWithout(usd: Estimate["usd"]): Estimate {
  return {
    extract: 1,
    synth: 1,
    seconds: [1, 2],
    tokensIn: [1, 2],
    tokensOut: [1, 2],
    usd,
    basis: "calibration",
  };
}

test("estimateCostLine: a known price wins over everything else", () => {
  const line = estimateCostLine(
    estimateWithout([0.001, 0.002]),
    "openai",
    true,
  );
  if (line !== "$0.0010-$0.0020") throw new Error(line);
});

test("estimateCostLine: a provider with no price list names itself, not OpenRouter", () => {
  for (const ai of ["openai", "anthropic"]) {
    const line = estimateCostLine(estimateWithout(undefined), ai, false);
    if (line !== "estimate unavailable for this provider") {
      throw new Error(`${ai}: ${line}`);
    }
  }
});

test("estimateCostLine: openrouter keeps its own two reasons", () => {
  const unreachable = estimateCostLine(
    estimateWithout(undefined),
    "openrouter",
    true,
  );
  if (!unreachable.includes("could not read OpenRouter prices")) {
    throw new Error(unreachable);
  }
  const noModels = estimateCostLine(estimateWithout(undefined), "none", false);
  if (!noModels.includes("--low-model=<id> --high-model=<id>")) {
    throw new Error(noModels);
  }
  const unpriced = estimateCostLine(
    estimateWithout(undefined),
    "openrouter",
    false,
    true,
  );
  if (unpriced !== "no OpenRouter price for these models") {
    throw new Error(unpriced);
  }
});
