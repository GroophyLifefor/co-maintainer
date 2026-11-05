/** Concurrency settings: resolution, recommendation, warnings and the limit
 * actually applied to work. Written before the product code (plan E1-E4).
 *
 * The module is loaded dynamically so each test names the missing behaviour
 * instead of failing once at import time. */
import { test } from "node:test";
import { readConfig, writeRepoConfig, writeUserConfig } from "../config.ts";
import { probePlan } from "./probe.ts";
import { AiBatch } from "../ai/batch.ts";
import type { AiProvider, AiRequest, GitHubClient } from "../types.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";

const MODULE = "./concurrency.ts";

type Concurrency = { gh: number; ai: number };
type Warning = { kind: string; message?: string; text?: string };

type ConcurrencyModule = {
  MIN_CONCURRENCY: number;
  MAX_CONCURRENCY: number;
  BUILTIN_CONCURRENCY: Concurrency;
  resolveConcurrency(repo: string, config?: unknown): Concurrency;
  recommendConcurrency(input: {
    githubJobs: number;
    provider: string;
    lowModel?: string;
    highModel?: string;
  }): Concurrency;
  concurrencyWarnings(input: {
    provider: string;
    lowModel?: string;
    highModel?: string;
    gh: number;
    ai: number;
    auth?: "gh" | "pat";
  }): Warning[];
};

let loaded: Promise<ConcurrencyModule> | undefined;

function concurrency(): Promise<ConcurrencyModule> {
  loaded ??= import(MODULE) as Promise<ConcurrencyModule>;
  return loaded;
}

function warningKinds(warnings: Warning[]): string[] {
  return warnings.map((warning) => warning.kind);
}

function warningText(warnings: Warning[]): string {
  return warnings
    .map((warning) => warning.message ?? warning.text ?? "")
    .join("\n");
}

async function withTempConfig(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "CM_CONFIG_PATH",
    "CM_APP_DB",
    "CM_REPOS_DIR",
    "XDG_CACHE_HOME",
  ] as const;
  const saved = keys.map((key) => [key, getEnv(key)] as const);
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  setEnv("XDG_CACHE_HOME", `${dir}/cache`);
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    }
  }
}

function writeConfig(value: Record<string, unknown>): Promise<void> {
  return writeUserConfig(value as never);
}

function writeRepo(
  repo: string,
  value: Record<string, unknown>,
): Promise<void> {
  return writeRepoConfig(repo, value as never);
}

test("resolution: repo override wins over the server default and the built-in values", async () => {
  const { resolveConcurrency } = await concurrency();
  await withTempConfig(async () => {
    const builtin = resolveConcurrency("acme/widgets");
    if (builtin.gh !== 1 || builtin.ai !== 3) {
      throw new Error(`built-in values: ${JSON.stringify(builtin)} (want 1/3)`);
    }

    await writeConfig({ defaults: { ghConcurrent: 4, aiConcurrent: 2 } });
    const server = resolveConcurrency("acme/widgets");
    if (server.gh !== 4 || server.ai !== 2) {
      throw new Error(
        `server default did not win over built-in: ${JSON.stringify(server)}`,
      );
    }

    await writeRepo("acme/widgets", { ghConcurrent: 8, aiConcurrent: 6 });
    const repo = resolveConcurrency("acme/widgets");
    if (repo.gh !== 8 || repo.ai !== 6) {
      throw new Error(
        `repo override did not win over server default: ${JSON.stringify(repo)}`,
      );
    }

    const other = resolveConcurrency("acme/other");
    if (other.gh !== 4 || other.ai !== 2) {
      throw new Error(
        `another repo stopped following the server default: ${JSON.stringify(other)}`,
      );
    }
  });
});

test("resolution: a missing repo value falls back field by field to the server default", async () => {
  const { resolveConcurrency } = await concurrency();
  await withTempConfig(async () => {
    await writeConfig({ defaults: { ghConcurrent: 4, aiConcurrent: 2 } });

    await writeRepo("acme/widgets", { ghConcurrent: 8 });
    const ghOnly = resolveConcurrency("acme/widgets");
    if (ghOnly.gh !== 8 || ghOnly.ai !== 2) {
      throw new Error(`gh-only override: ${JSON.stringify(ghOnly)} (want 8/2)`);
    }

    await writeRepo("acme/gadgets", { aiConcurrent: 6 });
    const aiOnly = resolveConcurrency("acme/gadgets");
    if (aiOnly.gh !== 4 || aiOnly.ai !== 6) {
      throw new Error(`ai-only override: ${JSON.stringify(aiOnly)} (want 4/6)`);
    }
  });
});

test("recommendation: GitHub jobs follow 2, 4 and 8 at the 19/20/99/100 boundaries", async () => {
  const { recommendConcurrency } = await concurrency();
  const cases: [number, number][] = [
    [0, 0],
    [1, 1],
    [19, 2],
    [20, 4],
    [99, 4],
    [100, 8],
    [1000, 8],
  ];
  for (const [jobs, wantGh] of cases) {
    const result = recommendConcurrency({
      githubJobs: jobs,
      provider: "openrouter",
      lowModel: "paid/low",
      highModel: "paid/high",
    });
    if (result.gh !== wantGh) {
      throw new Error(
        `${jobs} GitHub jobs recommended gh=${result.gh} (want ${wantGh})`,
      );
    }
    if (!Number.isInteger(result.gh) || result.gh < 0) {
      throw new Error(`gh is not a non-negative integer: ${result.gh}`);
    }
  }
});

test("recommendation: the AI ceiling is 8 on paid OpenRouter, 4 on OpenAI/Anthropic/OpenCode, and 1 on a free OpenRouter model", async () => {
  const { recommendConcurrency } = await concurrency();
  const recommend = (
    provider: string,
    lowModel?: string,
    highModel?: string,
  ): Concurrency =>
    recommendConcurrency({
      githubJobs: 100,
      provider,
      lowModel,
      highModel,
    });

  const paid = recommend("openrouter", "paid/low", "paid/high");
  if (paid.ai !== 8) throw new Error(`paid OpenRouter AI: ${paid.ai} (want 8)`);

  for (const provider of [
    "openai",
    "anthropic",
    "opencode-zen",
    "opencode-go",
  ]) {
    const result = recommend(provider, "paid/low", "paid/high");
    if (result.ai !== 4) {
      throw new Error(`${provider} AI: ${result.ai} (want 4)`);
    }
  }

  for (const [lowModel, highModel] of [
    ["deepseek/deepseek-chat-v3.1:free", "paid/high"],
    ["paid/low", "deepseek/deepseek-chat-v3.1:free"],
  ]) {
    const result = recommend("openrouter", lowModel, highModel);
    if (result.ai !== 1) {
      throw new Error(
        `free model ${lowModel}/${highModel} recommended AI ${result.ai} (want 1)`,
      );
    }
  }
});

test("recommendation: never above the job count, 16, NaN or negative", async () => {
  const { recommendConcurrency } = await concurrency();
  const recommend = (githubJobs: number): Concurrency =>
    recommendConcurrency({
      githubJobs,
      provider: "openrouter",
      lowModel: "paid/low",
      highModel: "paid/high",
    });

  const few = recommend(2);
  if (few.gh !== 2 || few.ai !== 2) {
    throw new Error(`two jobs: ${JSON.stringify(few)} (want 2/2)`);
  }

  const huge = recommend(100_000);
  if (huge.gh > 16 || huge.ai > 16) {
    throw new Error(`above the 16 ceiling: ${JSON.stringify(huge)}`);
  }

  for (const jobs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = recommend(jobs);
    if (!Number.isFinite(result.gh) || !Number.isFinite(result.ai)) {
      throw new Error(
        `${jobs} jobs produced a non-finite value: ${JSON.stringify(result)}`,
      );
    }
    if (result.gh < 0 || result.ai < 0) {
      throw new Error(
        `${jobs} jobs produced a negative value: ${JSON.stringify(result)}`,
      );
    }
    if (result.gh > 16 || result.ai > 16) {
      throw new Error(`${jobs} jobs exceeded 16: ${JSON.stringify(result)}`);
    }
  }
});

test("recommendation: zero jobs recommends no AI calls", async () => {
  const { recommendConcurrency } = await concurrency();
  const result = recommendConcurrency({
    githubJobs: 0,
    provider: "openrouter",
    lowModel: "paid/low",
    highModel: "paid/high",
  });
  if (result.ai !== 0) {
    throw new Error(`zero jobs recommended AI ${result.ai} (want 0)`);
  }
});

test("recommendation: is not applied to the saved settings by itself", async () => {
  const { recommendConcurrency, resolveConcurrency } = await concurrency();
  await withTempConfig(async () => {
    await writeConfig({ defaults: { ghConcurrent: 1, aiConcurrent: 3 } });
    const before = JSON.stringify(readConfig());

    const recommendation = recommendConcurrency({
      githubJobs: 100,
      provider: "openrouter",
      lowModel: "paid/low",
      highModel: "paid/high",
    });
    if (recommendation.gh === 1 && recommendation.ai === 3) {
      throw new Error("the test recommendation equals the saved default");
    }

    const after = JSON.stringify(readConfig());
    if (before !== after) {
      throw new Error("recommendation changed the saved config");
    }
    const resolved = resolveConcurrency("acme/widgets");
    if (resolved.gh !== 1 || resolved.ai !== 3) {
      throw new Error(
        `recommendation changed the resolved values: ${JSON.stringify(resolved)}`,
      );
    }
  });
});

test("warnings: a free OpenRouter model warns at AI 2 and clears at AI 1", async () => {
  const { concurrencyWarnings } = await concurrency();
  const warnings = (
    ai: number,
    lowModel: string,
    highModel: string,
  ): Warning[] =>
    concurrencyWarnings({
      provider: "openrouter",
      lowModel,
      highModel,
      gh: 1,
      ai,
    });

  const freeLow = warnings(2, "deepseek/deepseek-chat-v3.1:free", "paid/high");
  if (!warningKinds(freeLow).includes("free-model")) {
    throw new Error(`free low model at AI 2: ${JSON.stringify(freeLow)}`);
  }

  const freeHigh = warnings(2, "paid/low", "deepseek/deepseek-chat-v3.1:free");
  if (!warningKinds(freeHigh).includes("free-model")) {
    throw new Error(`free high model at AI 2: ${JSON.stringify(freeHigh)}`);
  }

  const cleared = warnings(1, "deepseek/deepseek-chat-v3.1:free", "paid/high");
  if (warningKinds(cleared).includes("free-model")) {
    throw new Error(
      `free-model warning stayed at AI 1: ${JSON.stringify(cleared)}`,
    );
  }
});

test("warnings: exceeding the provider ceiling warns about waiting", async () => {
  const { concurrencyWarnings } = await concurrency();
  const warnings = (provider: string, ai: number): Warning[] =>
    concurrencyWarnings({
      provider,
      lowModel: "paid/low",
      highModel: "paid/high",
      gh: 1,
      ai,
    });

  const above = warnings("openai", 5);
  if (!warningKinds(above).includes("provider-ceiling")) {
    throw new Error(`OpenAI at AI 5: ${JSON.stringify(above)}`);
  }
  if (!/slow|wait/i.test(warningText(above))) {
    throw new Error(
      `the wait warning has no wait wording: ${warningText(above)}`,
    );
  }

  const atCeiling = warnings("openai", 4);
  if (warningKinds(atCeiling).includes("provider-ceiling")) {
    throw new Error(`OpenAI at AI 4 warned: ${JSON.stringify(atCeiling)}`);
  }

  const openRouterAbove = warnings("openrouter", 9);
  if (!warningKinds(openRouterAbove).includes("provider-ceiling")) {
    throw new Error(`OpenRouter at AI 9: ${JSON.stringify(openRouterAbove)}`);
  }
});

test("warnings: a PAT at GitHub 8 warns about the request quota", async () => {
  const { concurrencyWarnings } = await concurrency();
  const warnings = (auth: "gh" | "pat", gh: number): Warning[] =>
    concurrencyWarnings({
      provider: "openrouter",
      lowModel: "paid/low",
      highModel: "paid/high",
      gh,
      ai: 1,
      auth,
    });

  const pat = warnings("pat", 8);
  if (!warningKinds(pat).includes("pat-quota")) {
    throw new Error(`PAT at GitHub 8: ${JSON.stringify(pat)}`);
  }
  if (!/5,000|5000|requests\/hour/i.test(warningText(pat))) {
    throw new Error(
      `the quota warning has no quota wording: ${warningText(pat)}`,
    );
  }

  const below = warnings("pat", 7);
  if (warningKinds(below).includes("pat-quota")) {
    throw new Error(`PAT at GitHub 7 warned: ${JSON.stringify(below)}`);
  }

  const ghCli = warnings("gh", 8);
  if (warningKinds(ghCli).includes("pat-quota")) {
    throw new Error(`gh CLI at GitHub 8 warned: ${JSON.stringify(ghCli)}`);
  }
});

test("warnings: do not block a selection", async () => {
  const { concurrencyWarnings } = await concurrency();
  const warnings = concurrencyWarnings({
    provider: "openrouter",
    lowModel: "deepseek/deepseek-chat-v3.1:free",
    highModel: "deepseek/deepseek-chat-v3.1:free",
    gh: 8,
    ai: 8,
    auth: "pat",
  });
  if (!Array.isArray(warnings) || warnings.length === 0) {
    throw new Error("the warning conditions produced no warnings");
  }
});

test("limits: the observed GitHub concurrency never exceeds the chosen limit", async () => {
  const { resolveConcurrency } = await concurrency();
  await withTempConfig(async () => {
    await writeConfig({ defaults: { ghConcurrent: 3, aiConcurrent: 2 } });
    const { gh } = resolveConcurrency("acme/widgets");

    let active = 0;
    let peak = 0;
    const pulls = Array.from({ length: 40 }, (_, index) => ({
      number: index + 1,
      updated_at: "2026-01-02T00:00:00Z",
      additions: 1,
      deletions: 0,
    }));
    const client: GitHubClient = {
      async request<T>(endpoint: string): Promise<T> {
        if (/\/pulls\/\d+$/.test(endpoint)) {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
          return { number: 1, additions: 1, deletions: 0 } as T;
        }
        return { default_branch: "main", has_issues: true } as T;
      },
      async pages<T>(endpoint: string): Promise<T[]> {
        if (/\/pulls\?/.test(endpoint)) return pulls as T[];
        return [] as T[];
      },
    };

    await probePlan(client, "acme/widgets", {
      ghConcurrent: gh,
      log: () => {},
    });

    if (peak > gh) {
      throw new Error(`observed GitHub peak ${peak} exceeded the chosen ${gh}`);
    }
    if (gh > 1 && peak < 2) {
      throw new Error(
        `the fake had enough work but only ${peak} GitHub calls overlapped`,
      );
    }
  });
});

test("limits: the observed AI concurrency never exceeds the chosen limit", async () => {
  const { resolveConcurrency } = await concurrency();
  await withTempConfig(async () => {
    await writeConfig({ defaults: { ghConcurrent: 1, aiConcurrent: 4 } });
    const { ai } = resolveConcurrency("acme/widgets");

    let active = 0;
    let peak = 0;
    const provider: AiProvider = {
      async complete(_request: AiRequest) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return {
          text: "ok",
          tokensIn: 1,
          tokensOut: 1,
          model: "fake/model",
          provider: "openrouter",
        };
      },
    };
    const batch = new AiBatch(provider, "acme/widgets", ai, "concurrency-test");
    const requests: AiRequest[] = Array.from({ length: 12 }, (_, index) => ({
      job: "test",
      system: "system",
      prompt: `prompt ${index}`,
      maxTokens: 10,
    }));
    await batch.run(requests);

    if (peak > ai) {
      throw new Error(`observed AI peak ${peak} exceeded the chosen ${ai}`);
    }
    if (ai > 1 && peak < 2) {
      throw new Error(
        `the fake had enough work but only ${peak} AI calls overlapped`,
      );
    }
  });
});
