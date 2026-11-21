/** One order for every setting, on every surface: environment, then the
 * repository's own value, then the global value, then the default.
 *
 * The repository is given the run's real review model and the global config a
 * model that does not exist, so a review that reads the wrong level fails
 * with a real model too. Every check reads what the product sent, printed or
 * stored, never what the model answered. */
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, OPENED_MATH, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides",
  split: "the repository gets its own model, the account a different one",
  appReview: "an App review of that repository",
  options: "remote and push reviews resolve the same values",
  envServe: "serve reads the same variables as the CLI",
  configGet: "config get shows what a run uses",
  setRepo: "set --repo writes and clears the repository's own values",
  webhook: "the dashboard shows the webhook URL serve uses",
  locks: "a field the environment sets is shown locked",
  noFilter: "--no-only-request-changed-pr turns a saved filter off",
  lastInit: "the last init is the fallback where the account has no value",
};

const GLOBAL_HIGH = "sim-account-model-that-does-not-exist";

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "any review",
    job: "review_pull_request",
    prompt: /[\s\S]*/,
    reply: { findings: [] },
  },
];

/** The model field of every AI request made while `step` ran. */
function modelsIn(sim: Sim, step: string): string[] {
  return sim.trace.ai
    .filter((call) => call.step === step)
    .map((call) => {
      const body = call.request as { model?: unknown } | undefined;
      return typeof body?.model === "string" ? body.model : "";
    })
    .filter(Boolean);
}

/** Runs `body` with these variables set, then puts the old values back. */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  body: () => Promise<T> | T,
): Promise<T> {
  const { setEnv, deleteEnv } = await import("../../../util/runtime.ts");
  const before = Object.fromEntries(
    Object.keys(vars).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) deleteEnv(name);
    else setEnv(name, value);
  }
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
  }
}

function repoConfig(sim: Sim): Record<string, unknown> {
  const repos = (sim.world.readConfig().repos ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  return repos[APP_REPO] ?? {};
}

function checks(sim: Sim): CheckResult[] {
  const realHigh = String(sim.state.realHigh ?? "");
  const afterInit = (sim.state.afterInit ?? {}) as Record<string, unknown>;
  const reviewModels = modelsIn(sim, STEP.appReview);
  const options = (sim.state.options ?? {}) as Record<string, string>;
  const envServe = (sim.state.envServe ?? {}) as Record<string, string>;
  const configGet = (sim.state.configGet ?? {}) as Record<string, string>;
  const setRepo = (sim.state.setRepo ?? {}) as Record<string, unknown>;
  const webhook = (sim.state.webhook ?? {}) as Record<string, unknown>;
  const locks = (sim.state.locks ?? {}) as Record<string, boolean>;
  const noFilter = (sim.state.noFilter ?? {}) as Record<string, boolean>;
  return [
    check(
      "init keeps the provider, the models and auth only as the init fallback, never as the repository's own values",
      !("ai" in afterInit) &&
        !("lowModel" in afterInit) &&
        !("highModel" in afterInit) &&
        !("auth" in afterInit) &&
        typeof (afterInit.initFallback as { highModel?: unknown } | undefined)
          ?.highModel === "string",
      `repository keys after init: ${Object.keys(afterInit).join(", ") || "none"}`,
    ),
    check(
      "an App review runs on the repository's own model, never the account's",
      reviewModels.length > 0 &&
        reviewModels.includes(realHigh) &&
        !reviewModels.includes(GLOBAL_HIGH),
      `${reviewModels.length} AI calls · models ${[...new Set(reviewModels)].join(", ")}`,
    ),
    check(
      "a remote review resolves the repository's model and blocking rule",
      options.remoteHigh === realHigh && options.remoteBlocking === "severity",
      `model ${options.remoteHigh} · blocking ${options.remoteBlocking}`,
    ),
    check(
      "ai=none falls back to OpenRouter for App and remote reviews alike",
      options.appNone === "openrouter" && options.remoteNone === "openrouter",
      `App ${options.appNone} · remote ${options.remoteNone}`,
    ),
    check(
      "a push review records the repository's model",
      options.pushModel === realHigh,
      `recorded ${options.pushModel}`,
    ),
    check(
      "serve reads HIGH_MODEL, CO_MAINTAINER_AI and CO_MAINTAINER_REVIEW_BLOCKING like the CLI, in App, remote and sync options",
      envServe.appHigh === "env-high" &&
        envServe.remoteHigh === "env-high" &&
        envServe.syncHigh === "env-high" &&
        envServe.appBlocking === "model" &&
        envServe.remoteBlocking === "model" &&
        envServe.syncAi === "openai",
      JSON.stringify(envServe),
    ),
    check(
      "config get prints the value a run uses, with --repo the repository's own",
      configGet.global === GLOBAL_HIGH &&
        configGet.repo === realHigh &&
        configGet.listSource.includes("repo"),
      `global ${configGet.global} · repo ${configGet.repo} · list ${configGet.listSource}`,
    ),
    check(
      "config get token ignores a key variable the configured provider never reads",
      configGet.token === "saved-anthropic-key",
      `printed ${configGet.token ? "a value" : "nothing"} ${configGet.token === "saved-anthropic-key" ? "(the saved key)" : ""}`,
    ),
    check(
      "set --repo writes a repository model and --unset gives the account's back",
      setRepo.written === "repo-set-model" &&
        setRepo.cleared === undefined &&
        setRepo.badExit !== 0,
      `written ${String(setRepo.written)} · after unset ${String(setRepo.cleared)} · bad provider exit ${String(setRepo.badExit)}`,
    ),
    check(
      "an empty CO_MAINTAINER_AI falls through to the saved provider",
      configGet.emptyAi === "anthropic",
      `printed ${configGet.emptyAi}`,
    ),
    check(
      "the dashboard shows the flag's webhook URL over the saved one, and names what locks it",
      webhook.shown === "https://flag.example.com/github/webhook" &&
        webhook.lockedBy === "--webhook-url" &&
        webhook.savedOnly === "https://saved.example.com/github/webhook",
      `with flag ${String(webhook.shown)} locked by ${String(webhook.lockedBy)} · without ${String(webhook.savedOnly)}`,
    ),
    check(
      "the dashboard refuses a webhook URL serve would refuse to start with",
      webhook.badStatus === 400,
      `status ${String(webhook.badStatus)}`,
    ),
    check(
      "a model the environment sets is shown locked, with the variable's name",
      locks.highLocked === true && locks.lowFree === true,
      JSON.stringify(locks),
    ),
    check(
      "a saved only-request-changed-pr applies, and --no-only-request-changed-pr turns it off for the run",
      noFilter.saved === true && noFilter.turnedOff === false,
      JSON.stringify(noFilter),
    ),
    check(
      "with no account model the last init's model runs, with one the account's wins",
      (sim.state.lastInit as Record<string, unknown> | undefined)?.noAccount ===
        "init-high" &&
        (sim.state.lastInit as Record<string, unknown> | undefined)
          ?.withAccount === "account-high",
      JSON.stringify(sim.state.lastInit),
    ),
    check(
      "the last init's model is never sent to another provider",
      (sim.state.lastInit as Record<string, unknown> | undefined)
        ?.otherProvider === undefined,
      `other provider gets ${String((sim.state.lastInit as Record<string, unknown> | undefined)?.otherProvider)}`,
    ),
    check(
      "a repository model an older release copied moves to the init fallback once, and a later set value stays",
      (sim.state.lastInit as Record<string, unknown> | undefined)?.moved ===
        "copied-high" &&
        (sim.state.lastInit as Record<string, unknown> | undefined)?.kept ===
          "set-high",
      JSON.stringify(sim.state.lastInit),
    ),
  ];
}

export default defineFlow({
  name: "setting-resolution",
  description:
    "every surface resolves AI, models, blocking and the webhook URL in one order: env, repository, account, default",
  ai: AI,
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await serveRepo(sim);
        sim.state.afterInit = repoConfig(sim);
        return `${APP_REPO} · guides built`;
      },
    },
    {
      name: STEP.split,
      async run(sim) {
        const realHigh = sim.options().highModel ?? "";
        sim.state.realHigh = realHigh;
        const config = sim.world.readConfig();
        const repos = (config.repos ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        sim.world.writeConfig({
          highModel: GLOBAL_HIGH,
          // The value below is set on purpose, not an old init copy.
          repoModelCopiesMoved: true,
          repos: {
            ...repos,
            [APP_REPO]: {
              ...repos[APP_REPO],
              highModel: realHigh,
              reviewBlocking: "severity",
            },
          },
        });
        return `repository ${realHigh} · account ${GLOBAL_HIGH}`;
      },
    },
    {
      name: STEP.appReview,
      async run(sim) {
        const pull: SimPull = sim.github.openPull(APP_REPO, {
          title: "Add divide and average",
          files: { "src/math.ts": OPENED_MATH },
        });
        const delivery = await sim.server.deliver(
          "pull_request",
          sim.server.payloads.pullRequest(pull, "opened"),
        );
        const jobs = await sim.server.runJobs();
        return `${String(delivery.body.outcome)} · ${jobs.map((job) => `${job.type} ${job.status}`).join(", ")}`;
      },
    },
    {
      name: STEP.options,
      async run(sim) {
        const { reviewOptions } = await import("../../../services/review.ts");
        const { reviewOptionsForRepo } =
          await import("../../../services/remote_review.ts");
        const { resolveRepoSettings, readConfig } =
          await import("../../../config.ts");
        const remote = reviewOptionsForRepo(APP_REPO, false);
        const before = sim.world.readConfig();
        sim.world.writeConfig({ ai: "none" });
        const appNone = reviewOptions(APP_REPO, 1).ai;
        const remoteNone = reviewOptionsForRepo(APP_REPO, false).ai;
        sim.world.writeConfig({ ai: before.ai });
        sim.state.options = {
          remoteHigh: remote.highModel ?? "",
          remoteBlocking: remote.reviewBlocking ?? "",
          appNone,
          remoteNone,
          pushModel:
            resolveRepoSettings(readConfig(), APP_REPO).highModel.value ?? "",
        };
        return JSON.stringify(sim.state.options);
      },
    },
    {
      name: STEP.envServe,
      async run(sim) {
        const { reviewOptions } = await import("../../../services/review.ts");
        const { reviewOptionsForRepo } =
          await import("../../../services/remote_review.ts");
        const { resolveRepoSettings, readConfig } =
          await import("../../../config.ts");
        const result = await withEnv(
          {
            HIGH_MODEL: "env-high",
            CO_MAINTAINER_REVIEW_BLOCKING: "model",
            CO_MAINTAINER_AI: "openai",
          },
          () => {
            const app = reviewOptions(APP_REPO, 1);
            const remote = reviewOptionsForRepo(APP_REPO, false);
            const sync = resolveRepoSettings(readConfig(), APP_REPO);
            return {
              appHigh: app.highModel ?? "",
              remoteHigh: remote.highModel ?? "",
              appBlocking: app.reviewBlocking ?? "",
              remoteBlocking: remote.reviewBlocking ?? "",
              syncHigh: sync.highModel.value ?? "",
              syncAi: sync.ai.value,
            };
          },
        );
        sim.state.envServe = result;
        return JSON.stringify(result);
      },
    },
    {
      name: STEP.configGet,
      async run(sim) {
        const before = sim.world.readConfig();
        const global = await sim.cli(["config", "get", "high-model"]);
        const repo = await sim.cli([
          "config",
          "get",
          "high-model",
          `--repo=${APP_REPO}`,
        ]);
        const list = await sim.cli(["config", "list", `--repo=${APP_REPO}`]);
        // A saved Anthropic key, and an OpenRouter variable that an Anthropic
        // run never reads. Read through the resolver `config get` prints, so
        // no key reaches the output.
        sim.world.writeConfig({
          ai: "anthropic",
          token: "saved-anthropic-key",
        });
        const { effectiveField } =
          await import("../../../cli/commands/config.ts");
        const { readConfig } = await import("../../../config.ts");
        const token = await withEnv(
          {
            OPENROUTER_API_KEY: "sk-or-unrelated",
            CO_MAINTAINER_TOKEN: undefined,
          },
          () => effectiveField(readConfig(), "token"),
        );
        const emptyAi = await sim.cli(["config", "get", "ai"], {
          env: { CO_MAINTAINER_AI: "" },
        });
        sim.world.writeConfig({ ai: before.ai, token: before.token });
        const highRow =
          list.stdout
            .split("\n")
            .find((line) => line.startsWith("high-model")) ?? "";
        sim.state.configGet = {
          global: global.stdout.trim(),
          repo: repo.stdout.trim(),
          listSource: highRow,
          token: String(token.value ?? ""),
          emptyAi: emptyAi.stdout.trim(),
        };
        return `global ${global.stdout.trim()} · repo ${repo.stdout.trim()}`;
      },
    },
    {
      name: STEP.setRepo,
      async run(sim) {
        await sim.cli([
          "set",
          `--repo=${APP_REPO}`,
          "--low-model=repo-set-model",
        ]);
        const written = repoConfig(sim).lowModel;
        await sim.cli(["set", `--repo=${APP_REPO}`, "--unset=low-model"]);
        const cleared = repoConfig(sim).lowModel;
        const bad = await sim.cli([
          "set",
          `--repo=${APP_REPO}`,
          "--ai=not-a-provider",
        ]);
        sim.state.setRepo = { written, cleared, badExit: bad.exitCode };
        return `written ${String(written)} · cleared ${String(cleared)} · bad exit ${bad.exitCode}`;
      },
    },
    {
      name: STEP.webhook,
      async run(sim) {
        const { handleSettingsRoute } =
          await import("../../../server/api/settings.ts");
        const { memoryPasswordStore } = await import("../../../server/auth.ts");
        sim.world.writeConfig({
          webhookUrl: "https://saved.example.com/github/webhook",
        });
        const store = memoryPasswordStore("sim-password-1234");
        const get = async (source: Record<string, string> | string) => {
          const response = await handleSettingsRoute(
            new Request("http://localhost/api/settings"),
            new URL("http://localhost/api/settings"),
            source,
            store,
            "127.0.0.1",
          );
          return (await response.json()) as Record<string, unknown>;
        };
        const withFlag = await get({
          webhookUrl: "http://localhost:5000/github/webhook",
          webhookUrlOverride: "https://flag.example.com/github/webhook",
          webhookUrlOverrideName: "--webhook-url",
        });
        const savedOnly = await get({
          webhookUrl: "http://localhost:5000/github/webhook",
        });
        const bad = await handleSettingsRoute(
          new Request("http://localhost/api/settings", {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "x-requested-with": "fetch",
            },
            body: JSON.stringify({ webhookUrl: "https://example.com" }),
          }),
          new URL("http://localhost/api/settings"),
          "http://localhost:5000/github/webhook",
          store,
          "127.0.0.1",
        );
        sim.state.webhook = {
          shown: withFlag.webhookUrl,
          lockedBy: withFlag.webhookUrlLockedBy,
          savedOnly: savedOnly.webhookUrl,
          badStatus: bad.status,
        };
        return JSON.stringify(sim.state.webhook);
      },
    },
    {
      name: STEP.locks,
      async run(sim) {
        const { renderSettingsPage } =
          await import("../../../server/pages/settings.ts");
        const { readConfig } = await import("../../../config.ts");
        const page = await withEnv({ HIGH_MODEL: "env-high" }, async () => {
          const response = renderSettingsPage(
            "sim",
            readConfig(),
            "",
            "http://localhost",
            "ai",
          );
          return response ? await response.text() : "";
        });
        const highTag = /<input id="high"[^>]*>/.exec(page)?.[0] ?? "";
        const lowTag = /<input id="low"[^>]*>/.exec(page)?.[0] ?? "";
        sim.state.locks = {
          highLocked:
            highTag.includes("disabled") &&
            page.includes("<code>HIGH_MODEL</code>"),
          lowFree: lowTag !== "" && !lowTag.includes("disabled"),
        };
        return JSON.stringify(sim.state.locks);
      },
    },
    {
      name: STEP.noFilter,
      async run(sim) {
        const { parseArgs } = await import("../../../cli/args.ts");
        const repos = (sim.world.readConfig().repos ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        sim.world.writeConfig({
          repos: {
            ...repos,
            [APP_REPO]: {
              ...repos[APP_REPO],
              onlyRequestChangedPr: true,
            },
          },
        });
        const base = [
          "sync",
          APP_REPO,
          "--auth=gh",
          "--ai=openrouter",
          "--token=sim-unused-key",
          "--low-model=a",
          "--high-model=b",
          "--json",
        ];
        const saved = (await parseArgs(base)).onlyRequestChangedPr;
        const turnedOff = (
          await parseArgs([...base, "--no-only-request-changed-pr"])
        ).onlyRequestChangedPr;
        sim.state.noFilter = { saved, turnedOff };
        return JSON.stringify(sim.state.noFilter);
      },
    },
    {
      name: STEP.lastInit,
      async run(sim) {
        const { resolveRepoSettings, movedRepoModelCopies } =
          await import("../../../config.ts");
        const repo = "sim/fallback";
        const base = {
          repoModelCopiesMoved: true,
          repos: {
            [repo]: {
              initFallback: {
                ai: "openrouter" as const,
                highModel: "init-high",
              },
            },
          },
        };
        const env = () => undefined;
        const noAccount = resolveRepoSettings(base, repo, env).highModel.value;
        const withAccount = resolveRepoSettings(
          { ...base, highModel: "account-high" },
          repo,
          env,
        ).highModel.value;
        const otherProvider = resolveRepoSettings(
          { ...base, ai: "anthropic" },
          repo,
          env,
        ).highModel.value;
        // An old config: the copy is moved. A marked one: the value stays.
        const moved = movedRepoModelCopies({
          repos: { [repo]: { highModel: "copied-high" } },
        }).repos?.[repo]?.initFallback?.highModel;
        const kept = movedRepoModelCopies({
          repoModelCopiesMoved: true,
          repos: { [repo]: { highModel: "set-high" } },
        }).repos?.[repo]?.highModel;
        sim.state.lastInit = {
          noAccount,
          withAccount,
          otherProvider,
          moved,
          kept,
        };
        return JSON.stringify(sim.state.lastInit);
      },
    },
  ],
  checks,
});
