/** CORE-24 tests: the probe estimate, the reason text, and `--run`.
 *
 * The estimate is pure arithmetic over a price map, so it is tested directly.
 * Pricing and `--run` touch the network and the init path, so they run through
 * the fake OpenRouter and the CLI harness. */
import { test } from "node:test";
import {
  estimateInit,
  extractJobCount,
  readJobHistory,
} from "../ai/estimate.ts";
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

test("estimate: the calibrated run costs about what the plan measured", () => {
  // The plan measured 5 extract + 9 synth jobs over 151 s. The section list
  // is the source of the 10 (so 9 was that run's dirty-section count), which
  // is why the assertion is on the job total rather than the split.
  const estimate = estimateInit({
    pullRequests: 4,
    includeCodebase: true,
    lowModel: "low",
    highModel: "high",
    prices: new Map([
      ["low", PRICE],
      ["high", PRICE],
    ]),
  });
  if (estimate.extract !== 5) throw new Error(`extract: ${estimate.extract}`);
  if (estimate.synth !== sectionKeys.length) {
    throw new Error(`synth: ${estimate.synth}`);
  }
  const jobs = estimate.extract + estimate.synth;
  if (jobs !== 15) throw new Error(`jobs: ${jobs}`);
  // 15 jobs at 10.8 s is about 162 s, and the measured run was 151 s.
  if (!(estimate.seconds[0] < 151 && estimate.seconds[1] > 151)) {
    throw new Error(`seconds: ${JSON.stringify(estimate.seconds)}`);
  }
  // With $1/$2 per million and 15 jobs, the range is cents not dollars.
  if (!estimate.usd || estimate.usd[1] > 1) {
    throw new Error(`usd: ${JSON.stringify(estimate.usd)}`);
  }
  if (estimate.basis !== "calibration") {
    throw new Error(`basis: ${estimate.basis}`);
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
    // 12 jobs at 3 s is 36 s either side of the 25% spread.
    if (estimate.seconds[1] > 50 || estimate.seconds[0] > 36) {
      throw new Error(
        `seconds from history: ${JSON.stringify(estimate.seconds)}`,
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
  // numbers beside it contradicted (CORE-24).
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
