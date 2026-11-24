import { parseAiBaseUrl, presetBaseUrl } from "../../ai/openai_compatible.ts";
import {
  readConfig,
  type UserConfig,
  resolveAppPrivateKey,
  configPath,
  savedKeyProvider,
  writeRepoConfig,
  writeUserConfig,
} from "../../config.ts";
import {
  checkReviewSystemPrompt,
  reviewSystemPromptLimit,
} from "../../review/system_prompt.ts";
import type { RepoConfig } from "../../config.ts";
import { canonicalRepoName } from "../../util/repo_name.ts";
import { parseCompanionsSetting } from "../../pr/companion_prs.ts";
import {
  DiagramSettingError,
  diagramOptionsFrom,
} from "../../review/diagram.ts";
import { hashPassword, passwordProblem } from "../../util/password.ts";
import { nowIso } from "../../util/time.ts";
import { readTextFile, readTextFileCapped } from "../../util/runtime.ts";

/** Largest MCP config file `set --mcp-config` reads. */
const MCP_CONFIG_MAX_BYTES = 1024 * 1024;
import { verifyAiKey } from "../../ai/verify.ts";
import { testAppAccess, testGithubAccess } from "../../services/credentials.ts";
import { die } from "../error.ts";
import { withAppDb } from "../../store/app_db.ts";
import { getRepo, updateRepoSettings } from "../../store/repos.ts";
import { parseRemakeCron } from "../../services/remake_cron.ts";
import { webhookUrlProblem } from "../../server/webhook_url.ts";
import { excludePatternError } from "../../pr/exclude.ts";
import { parsePolicy } from "../../services/review_policy.ts";
import { isCodegraphVersion } from "../../tools/codegraph.ts";
import {
  MCP_DISABLED_MESSAGE,
  McpConfigError,
  mcpDisabled,
  mcpServersSummary,
  parseMcpConfig,
} from "../../tools/mcp_config.ts";
import { AI_PROVIDERS, rejectRetiredProvider } from "../../ai/provider.ts";
import {
  GLOBAL_REASONING_EFFORTS,
  isGlobalReasoningEffort,
} from "../../ai/reasoning.ts";
import {
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
} from "../../services/concurrency.ts";
import { renderCommandHelp, renderGlobalHelp } from "./registry.ts";

function text(args: string[], name: string): string | undefined {
  return args
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

function concurrencyValue(raw: string, flag: string): number {
  const number = Number(raw);
  if (
    raw.trim() === "" ||
    !Number.isInteger(number) ||
    number < MIN_CONCURRENCY ||
    number > MAX_CONCURRENCY
  ) {
    die(
      `${flag} must be an integer between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}`,
    );
  }
  return number;
}

const secretFields = new Set([
  "token",
  "githubPat",
  "githubAppPrivateKey",
  "githubWebhookSecret",
  "githubOAuthClientSecret",
  "remoteToken",
  "dashboardPasswordHash",
  "remoteByok",
]);

/** `co-maintainer set --token=... --ai=... --low-model=... --high-model=...
 * --auth=... --github-app-id=... --github-app-private-key=... (or
 * --github-app-private-key-file=path or --github-app-private-key-path=path)
 * --github-webhook-secret=...`,
 * persists global defaults, including secrets, to config.json so every
 * other command can skip both the flag and the interactive prompt. See
 * docs/md/configuration.md for the tradeoff. */
export async function runSet(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(renderCommandHelp("set") ?? renderGlobalHelp());
    return;
  }
  const known = [
    "token",
    "ai-key",
    "ai-base-url",
    "ai-preset",
    "ai-resource",
    "ai-region",
    "ai-allow-http",
    "ai",
    "low-model",
    "high-model",
    "auth",
    "github-pat",
    "github-app-id",
    "github-app-private-key",
    "github-app-private-key-file",
    "github-app-private-key-path",
    "github-webhook-secret",
    "github-oauth-client-id",
    "github-oauth-client-secret",
    "github-oauth-allowed-user",
    "disable-auth",
    "enable-auth",
    "remote-host",
    "remote-token",
    "remote-byok-policy",
    "remote-client-tools-policy",
    "remote-byok",
    "remote-byok-default",
    "review-policy",
    "review-policy-file",
    "review-blocking",
    "review-event",
    "review-references",
    "ai-timeout-minutes",
    "global-reasoning-effort",
    "codegraph-version",
    "gh-concurrent",
    "ai-concurrent",
    "repo",
    "review-system-prompt",
    "review-system-prompt-max-chars",
    ...DIAGRAM_FLAGS,
    "review-read-diff-max-chars",
    ...TOOL_LIMIT_FLAGS.map(([flag]) => flag),
    "mcp-config",
    "mcp-allow-forks",
    "guide-full-every",
    "companions",
    "password",
    "extension-rerun-on-restart",
    "webhook-url",
    ...SERVER_INT_FLAGS.map(([flag]) => flag),
    ...Object.keys(REPO_DB_FLAGS),
    "remake-cron",
    "unset",
  ];
  const verify = !args.includes("--no-verify");
  for (const arg of args) {
    if (arg === "--no-verify") continue;
    if (
      !arg.startsWith("--") ||
      !known.some((name) => arg.startsWith(`--${name}=`))
    ) {
      die(`Unknown option: ${arg}`);
    }
  }

  // `--repo` turns `set` into a write to `repos[owner/repo]` in config.json.
  // Only the repository-scoped settings are accepted alongside it.
  const repoArg = text(args, "repo");
  if (repoArg !== undefined) {
    await runSetRepo(repoArg, args);
    return;
  }
  for (const name of [
    ...DIAGRAM_FLAGS,
    "review-references",
    "mcp-config",
    "mcp-allow-forks",
    "companions",
  ]) {
    if (text(args, name) !== undefined) die(`--${name} needs --repo`);
  }

  const ai = text(args, "ai");
  rejectRetiredProvider(ai);
  if (ai && !(AI_PROVIDERS as readonly string[]).includes(ai)) {
    die(`--ai must be one of: ${AI_PROVIDERS.join(", ")}`);
  }
  const auth = text(args, "auth");
  if (auth && !["gh", "pat"].includes(auth)) {
    die("--auth must be one of: gh, pat");
  }
  const providedKeySources = [
    text(args, "github-app-private-key"),
    text(args, "github-app-private-key-file"),
    text(args, "github-app-private-key-path"),
  ].filter((value) => value !== undefined);
  if (providedKeySources.length > 1) {
    die(
      "Pass only one of --github-app-private-key, --github-app-private-key-file, or --github-app-private-key-path",
    );
  }

  const fieldByFlag: Record<string, string> = {
    token: "token",
    "ai-key": "token",
    "ai-base-url": "aiBaseUrl",
    "ai-allow-http": "aiAllowHttp",
    ai: "ai",
    "low-model": "lowModel",
    "high-model": "highModel",
    auth: "auth",
    "github-pat": "githubPat",
    "github-app-id": "githubAppId",
    "github-app-private-key": "githubAppPrivateKey",
    "github-app-private-key-path": "githubAppPrivateKeyPath",
    "github-webhook-secret": "githubWebhookSecret",
    "github-oauth-client-id": "githubOAuthClientId",
    "github-oauth-client-secret": "githubOAuthClientSecret",
    "github-oauth-allowed-user": "githubOAuthAllowedUser",
    "disable-auth": "passwordAuthDisabled",
    "enable-auth": "githubAuthEnabled",
    "remote-host": "remoteHost",
    "remote-token": "remoteToken",
    "remote-byok-policy": "remoteByokPolicy",
    "remote-client-tools-policy": "remoteClientToolsPolicy",
    "remote-byok": "remoteByok",
    "remote-byok-default": "remoteByokDefault",
    "review-policy": "reviewPolicy",
    "review-blocking": "reviewBlocking",
    "review-event": "reviewEvent",
    "ai-timeout-minutes": "aiTimeoutMinutes",
    "global-reasoning-effort": "globalReasoningEffort",
    "codegraph-version": "codegraphVersion",
    password: "dashboardPasswordHash",
    "extension-rerun-on-restart": "extensionRerunOnRestart",
    "webhook-url": "webhookUrl",
    ...Object.fromEntries(SERVER_INT_FLAGS),
  };
  const unset = new Set(
    args
      .filter((arg) => arg.startsWith("--unset="))
      .map((arg) => arg.slice("--unset=".length)),
  );
  const patch: Record<string, unknown> = {};
  for (const [flag, field] of Object.entries(fieldByFlag)) {
    if (unset.has(field) || unset.has(flag)) patch[field] = undefined;
  }
  if (ai) patch.ai = ai;
  if (auth) patch.auth = auth;
  const lowModel = text(args, "low-model");
  if (lowModel) patch.lowModel = lowModel;
  const highModel = text(args, "high-model");
  if (highModel) patch.highModel = highModel;
  const token = text(args, "token") ?? text(args, "ai-key");
  if (token) patch.token = token;
  // openai-compatible: the address, from a preset or given whole.
  const allowHttp = text(args, "ai-allow-http");
  if (allowHttp !== undefined) {
    if (!["true", "false"].includes(allowHttp)) {
      die("--ai-allow-http must be true or false");
    }
    patch.aiAllowHttp = allowHttp === "true";
  }
  const preset = text(args, "ai-preset");
  let baseUrl = text(args, "ai-base-url");
  if (preset && baseUrl) die("Pass --ai-preset or --ai-base-url, not both.");
  if (preset) {
    const filled = presetBaseUrl(preset, {
      resource: text(args, "ai-resource"),
      region: text(args, "ai-region"),
    });
    if (!filled.ok) die(filled.problem);
    baseUrl = filled.url;
  }
  if (baseUrl !== undefined) {
    const parsed = parseAiBaseUrl(baseUrl, {
      allowHttp: Boolean(patch.aiAllowHttp ?? readConfig().aiAllowHttp),
    });
    if (!parsed.ok) die(parsed.problem);
    patch.aiBaseUrl = parsed.value.base;
    patch.ai ??= "openai-compatible";
  }
  const webhookUrl = text(args, "webhook-url");
  if (webhookUrl) {
    const problem = webhookUrlProblem(webhookUrl);
    if (problem) die(problem.replace(/^webhook URL/, "--webhook-url"));
    patch.webhookUrl = webhookUrl.trim();
  }
  // Settings the dashboard already wrote, now writable from the CLI too.
  for (const [flag, field] of SERVER_INT_FLAGS) {
    const raw = text(args, flag);
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      die(`--${flag} must be a positive whole number`);
    }
    patch[field] = value;
  }
  const githubPat = text(args, "github-pat");
  if (githubPat) patch.githubPat = githubPat;
  const githubAppId = text(args, "github-app-id");
  if (githubAppId) patch.githubAppId = githubAppId;
  const githubWebhookSecret = text(args, "github-webhook-secret");
  if (githubWebhookSecret) patch.githubWebhookSecret = githubWebhookSecret;
  const githubAppPrivateKey = text(args, "github-app-private-key");
  if (githubAppPrivateKey) patch.githubAppPrivateKey = githubAppPrivateKey;
  const privateKeyFile = text(args, "github-app-private-key-file");
  if (privateKeyFile) {
    try {
      patch.githubAppPrivateKey = await readTextFile(privateKeyFile);
    } catch (error) {
      die(`Could not read ${privateKeyFile}: ${String(error)}`);
    }
  }
  // The path form keeps the key on disk: only the location is stored, and it
  // is read at startup. Passing one of the other two forms also clears a
  // previously saved path so the inline key or file wins unambiguously.
  const privateKeyPath = text(args, "github-app-private-key-path");
  if (privateKeyPath) {
    patch.githubAppPrivateKeyPath = privateKeyPath;
    patch.githubAppPrivateKey = undefined;
  } else if (githubAppPrivateKey || privateKeyFile) {
    patch.githubAppPrivateKeyPath = undefined;
  }
  const oauthClientId = text(args, "github-oauth-client-id");
  if (oauthClientId) patch.githubOAuthClientId = oauthClientId;
  const oauthClientSecret = text(args, "github-oauth-client-secret");
  if (oauthClientSecret) patch.githubOAuthClientSecret = oauthClientSecret;
  const oauthAllowedUser = text(args, "github-oauth-allowed-user");
  if (oauthAllowedUser) patch.githubOAuthAllowedUser = oauthAllowedUser;
  // Both flags take either method, so password sign-in can be turned back on
  // and GitHub sign-in off from the CLI too.
  for (const [flag, on] of [
    ["disable-auth", false],
    ["enable-auth", true],
  ] as const) {
    const method = text(args, flag);
    if (!method) continue;
    if (method === "password") patch.passwordAuthDisabled = !on;
    else if (method === "github") patch.githubAuthEnabled = on;
    else die(`--${flag} must be password or github`);
  }
  // The same check the dashboard runs before it saves, so a saved state can
  // never stop the next `serve`.
  if (
    patch.passwordAuthDisabled !== undefined ||
    patch.githubAuthEnabled !== undefined
  ) {
    const merged = { ...readConfig(), ...patch };
    if (merged.passwordAuthDisabled && !merged.githubAuthEnabled) {
      die(
        "at least one sign-in method is required. Enable GitHub sign-in first with --enable-auth=github",
      );
    }
    if (
      merged.githubAuthEnabled &&
      (!merged.githubOAuthClientId ||
        !merged.githubOAuthClientSecret ||
        !merged.githubOAuthAllowedUser)
    ) {
      die(
        "GitHub sign-in needs --github-oauth-client-id, --github-oauth-client-secret and --github-oauth-allowed-user",
      );
    }
  }
  const remoteHost = text(args, "remote-host");
  if (remoteHost) patch.remoteHost = remoteHost;
  const remoteToken = text(args, "remote-token");
  if (remoteToken) patch.remoteToken = remoteToken;
  const remoteByokPolicy = text(args, "remote-byok-policy");
  if (remoteByokPolicy) {
    if (!["off", "allow", "require"].includes(remoteByokPolicy)) {
      die("--remote-byok-policy must be one of: off, allow, require");
    }
    patch.remoteByokPolicy = remoteByokPolicy;
  }
  const remoteClientToolsPolicy = text(args, "remote-client-tools-policy");
  if (remoteClientToolsPolicy) {
    if (!["off", "on"].includes(remoteClientToolsPolicy)) {
      die("--remote-client-tools-policy must be one of: off, on");
    }
    patch.remoteClientToolsPolicy = remoteClientToolsPolicy;
  }
  const remoteByok = text(args, "remote-byok");
  if (remoteByok) patch.remoteByok = remoteByok;
  const remoteByokDefault = text(args, "remote-byok-default");
  if (remoteByokDefault) {
    if (!["on", "off"].includes(remoteByokDefault)) {
      die("--remote-byok-default must be one of: on, off");
    }
    patch.remoteByokDefault = remoteByokDefault === "on";
  }
  const reviewPolicy = text(args, "review-policy");
  const reviewPolicyFile = text(args, "review-policy-file");
  if (reviewPolicy && reviewPolicyFile) {
    die("Pass only one of --review-policy or --review-policy-file");
  }
  if (reviewPolicy) {
    const checked = parsePolicy(reviewPolicy);
    if (!checked.ok) die(`--review-policy: ${checked.problem}`);
    patch.reviewPolicy = reviewPolicy;
  }
  if (reviewPolicyFile) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readTextFile(reviewPolicyFile));
    } catch (error) {
      die(
        `Could not read a JSON policy from ${reviewPolicyFile}: ${String(error)}`,
      );
    }
    const checked = parsePolicy(parsed);
    if (!checked.ok) die(`--review-policy-file: ${checked.problem}`);
    patch.reviewPolicy = parsed;
  }
  const reviewBlocking = text(args, "review-blocking");
  if (reviewBlocking) {
    if (!["model", "severity"].includes(reviewBlocking)) {
      die("--review-blocking must be one of: model, severity");
    }
    patch.reviewBlocking = reviewBlocking;
  }
  const reviewEvent = text(args, "review-event");
  if (reviewEvent) {
    if (!["auto", "comment"].includes(reviewEvent)) {
      die("--review-event must be one of: auto, comment");
    }
    patch.reviewEvent = reviewEvent;
  }
  const aiTimeout = text(args, "ai-timeout-minutes");
  if (aiTimeout !== undefined) {
    const minutes = Number(aiTimeout);
    if (!/^\d+$/.test(aiTimeout.trim()) || minutes <= 0) {
      die("--ai-timeout-minutes must be a positive whole number of minutes");
    }
    patch.aiTimeoutMinutes = minutes;
  }
  const reasoning = text(args, "global-reasoning-effort");
  if (reasoning !== undefined) {
    if (!isGlobalReasoningEffort(reasoning)) {
      die(
        `--global-reasoning-effort must be one of: ${GLOBAL_REASONING_EFFORTS.join(", ")}`,
      );
    }
    patch.globalReasoningEffort = reasoning;
  }
  const rawCodegraphVersion = text(args, "codegraph-version");
  if (rawCodegraphVersion !== undefined && rawCodegraphVersion.trim() !== "") {
    // Match the reader: a leading `v` is accepted and dropped, so `set` and
    // `codegraphVersion()` agree on what a version looks like.
    const normalized = rawCodegraphVersion.trim().replace(/^v/, "");
    if (!isCodegraphVersion(normalized)) {
      die("--codegraph-version must be a version like 1.6.0");
    }
    patch.codegraphVersion = normalized;
  }
  const ghConcurrent = text(args, "gh-concurrent");
  const aiConcurrent = text(args, "ai-concurrent");
  const unsetGh = unset.has("gh-concurrent") || unset.has("ghConcurrent");
  const unsetAi = unset.has("ai-concurrent") || unset.has("aiConcurrent");
  if (
    ghConcurrent !== undefined ||
    aiConcurrent !== undefined ||
    unsetGh ||
    unsetAi
  ) {
    const defaults = { ...(readConfig().defaults ?? {}) };
    if (unsetGh) delete defaults.ghConcurrent;
    if (unsetAi) delete defaults.aiConcurrent;
    if (ghConcurrent !== undefined) {
      defaults.ghConcurrent = concurrencyValue(ghConcurrent, "--gh-concurrent");
    }
    if (aiConcurrent !== undefined) {
      defaults.aiConcurrent = concurrencyValue(aiConcurrent, "--ai-concurrent");
    }
    patch.defaults = defaults;
  }
  const rerunOnRestart = text(args, "extension-rerun-on-restart");
  if (rerunOnRestart !== undefined) {
    if (!["true", "false"].includes(rerunOnRestart)) {
      die("--extension-rerun-on-restart must be true or false");
    }
    patch.extensionRerunOnRestart = rerunOnRestart === "true";
  }
  const password = text(args, "password");
  if (password) {
    const problem = passwordProblem(password);
    if (problem) die(`--password: ${problem}`);
    patch.dashboardPasswordHash = await hashPassword(password);
  }

  if (Object.keys(patch).length === 0) {
    die(
      "Nothing to set. Pass --token= (or --ai-key=), --ai=, --low-model=, --high-model=, --auth=, --github-pat=, " +
        "--github-app-id=, --github-app-private-key(-file|-path)=, --github-webhook-secret=, " +
        "--github-oauth-client-id=, --github-oauth-client-secret=, --github-oauth-allowed-user=, " +
        "--remote-host=, --remote-token=, --remote-byok-policy=off|allow|require, " +
        "--remote-client-tools-policy=off|on, " +
        "--review-blocking=model|severity, --ai-timeout-minutes=N, --global-reasoning-effort=LEVEL, --codegraph-version=SEMVER, " +
        "--password=, --disable-auth=password, --enable-auth=github, or --unset=name",
    );
  }

  // Verify the key and model before writing, so a typo fails here instead of
  // after a review has already fetched and cloned the pull request.
  // A field present in the patch wins, including when its value is `undefined`.
  // That is an unset, and there is nothing left to verify.
  const before = readConfig();
  const effective = (field: keyof typeof patch): unknown =>
    field in patch ? patch[field] : before[field as keyof typeof before];
  const effectiveAi = effective("ai");
  const effectiveToken = effective("token");
  // The saved key and model belong to the saved provider. A switch without a
  // new key would hand the old provider's key to the new one.
  const previousAi = savedKeyProvider(before);
  const switching =
    typeof patch.ai === "string" &&
    patch.ai !== "none" &&
    patch.ai !== previousAi;
  // A key goes only to the address it was given for. A new address, or a
  // switch to openai-compatible, drops the saved key unless a key comes
  // with it, and what the old server taught about models with it.
  const baseChanged =
    "aiBaseUrl" in patch && patch.aiBaseUrl !== before.aiBaseUrl;
  if (
    (baseChanged || (switching && patch.ai === "openai-compatible")) &&
    !("token" in patch)
  ) {
    if (before.token) {
      console.error(
        "[set] the AI address changed, so the saved key was dropped. Pass --ai-key= if the new server needs one.",
      );
    }
    patch.token = undefined;
  }
  if (baseChanged) patch.aiModelQuirks = undefined;
  if (switching && !("token" in patch) && before.token) {
    die(
      `The saved key is for ${previousAi}. Pass --token= with the ${String(patch.ai)} key to switch providers.`,
    );
  }
  const effectiveHighModel =
    switching && !("highModel" in patch) ? undefined : effective("highModel");
  // Only a run that changes the provider, the key or the review model asks
  // the provider, as the dashboard does. A `set` of anything else must not
  // reach the network.
  const touchingAi =
    patch.ai !== undefined ||
    patch.token !== undefined ||
    patch.highModel !== undefined ||
    patch.aiBaseUrl !== undefined;
  if (
    verify &&
    touchingAi &&
    (effectiveToken || effectiveAi === "openai-compatible") &&
    typeof effectiveAi === "string"
  ) {
    const result = await verifyAiKey(
      effectiveAi,
      String(effectiveToken ?? ""),
      effectiveHighModel === undefined ? undefined : String(effectiveHighModel),
      {
        aiBaseUrl: effective("aiBaseUrl") as string | undefined,
        aiAllowHttp: effective("aiAllowHttp") as boolean | undefined,
      },
    );
    // A model that refuses tools still reviews, without them.
    if (
      result.status === "ok" &&
      result.tools === false &&
      effectiveHighModel !== undefined
    ) {
      const quirks = {
        ...(effective("aiModelQuirks") as UserConfig["aiModelQuirks"]),
      };
      const name = String(effectiveHighModel);
      quirks[name] = { ...quirks[name], tools: false };
      patch.aiModelQuirks = quirks;
      console.error(
        `[set] ${name} does not take tools here. Reviews run without the codegraph and MCP tools.`,
      );
    }
    if (result.status === "rejected") throw result.error;
    if (result.status === "unreachable") {
      console.error(
        `[set] could not verify the key and model (${result.reason}). Saved anyway.`,
      );
    }
  }
  // The GitHub checks the dashboard runs before it saves, so a PAT or an App
  // the dashboard would refuse is refused here too.
  if (verify && (patch.auth !== undefined || patch.githubPat !== undefined)) {
    const merged = { ...readConfig(), ...patch };
    const github = await testGithubAccess({
      auth: merged.auth === "pat" ? "pat" : "gh",
      githubPat: merged.githubPat,
    });
    if (!github.ok) die(github.message);
  }
  if (
    verify &&
    (patch.githubAppId !== undefined ||
      patch.githubAppPrivateKey !== undefined ||
      patch.githubAppPrivateKeyPath !== undefined)
  ) {
    const merged = { ...readConfig(), ...patch };
    const app = await testAppAccess({
      appId: merged.githubAppId ?? "",
      privateKeyPem: resolveAppPrivateKey(merged) ?? "",
    });
    if (!app.ok) die(app.message);
  }

  // A changed password, allowed user, or sign-in method must not leave old
  // dashboard sessions valid. A running `serve` holds app.db, so instead of
  // deleting sessions here the change time goes into config.json and
  // `verifySession` refuses every session issued before it.
  const credentialChanged =
    patch.dashboardPasswordHash !== undefined ||
    patch.passwordAuthDisabled !== undefined ||
    patch.githubAuthEnabled !== undefined ||
    patch.githubOAuthAllowedUser !== undefined;
  await writeUserConfig(
    credentialChanged ? { ...patch, credentialsChangedAt: nowIso() } : patch,
  );
  const summary = Object.entries(patch).map(([key, value]) =>
    value === undefined
      ? `${key} (unset)`
      : `${key}=${secretFields.has(key) ? "•".repeat(8) : value}`,
  );
  console.log(`[set] updated: ${summary.join(", ")}`);
  console.log(`Saved to ${configPath()}`);
}

/** The diagram settings. They are repository settings only, so the App
 * reviews `serve` runs can read them too. */
const DIAGRAM_FLAGS = [
  "diagram-runtime",
  "plantuml-server",
  "plantuml-output-format",
];

/** The review tool limits: flag, field. Each takes an integer, and 0 or -1
 * means no limit. */
const TOOL_LIMIT_FLAGS = [
  ["review-tool-result-max-chars", "reviewToolResultMaxChars"],
  ["review-tool-budget-chars", "reviewToolBudgetChars"],
  ["review-search-max-context-lines", "reviewSearchMaxContextLines"],
  ["review-diff-max-chars", "reviewDiffMaxChars"],
  ["review-file-patch-max-chars", "reviewFilePatchMaxChars"],
] as const;

/** Server settings that are positive whole numbers. The dashboard wrote them
 * long before `set` could. */
const SERVER_INT_FLAGS = [
  ["max-concurrent-jobs", "maxConcurrentJobs"],
  ["remote-sync-timeout-seconds", "remoteSyncTimeoutSeconds"],
  [
    "max-concurrent-remote-reviews-per-token",
    "maxConcurrentRemoteReviewsPerToken",
  ],
  ["remote-tool-output-max-chars", "remoteToolOutputMaxChars"],
] as const;

/** Repository values that override the global one for this repository only.
 * Without one the repository inherits the global value, so a later global
 * change reaches it. */
const REPO_TEXT_FLAGS = [
  ["ai", "ai"],
  ["low-model", "lowModel"],
  ["high-model", "highModel"],
  ["auth", "auth"],
  ["review-blocking", "reviewBlocking"],
  ["review-event", "reviewEvent"],
  ["review-exclude", "reviewExclude"],
  ["only-request-changed-pr", "onlyRequestChangedPr"],
] as const;

/** Repository switches the dashboard keeps in app.db. `set --repo` writes
 * them there too, next to a running `serve` if there is one. */
const REPO_DB_FLAGS: Record<string, { values: string[]; describe: string }> = {
  "auto-review": { values: ["on", "off"], describe: "on or off" },
  "review-scope": {
    values: ["whole-pr", "incremental"],
    describe: "whole-pr or incremental",
  },
  "skip-drafts": { values: ["true", "false"], describe: "true or false" },
  "skip-bots": { values: ["true", "false"], describe: "true or false" },
  codegraph: { values: ["on", "off"], describe: "on or off" },
  "watch-open-issues": { values: ["on", "off"], describe: "on or off" },
  "watch-push-mode": {
    values: ["queue", "cancel-and-merge"],
    describe: "queue or cancel-and-merge",
  },
};

/** Flag names that make sense together with `--repo`. Anything else is a
 * global setting and is refused rather than silently written to the wrong
 * place. */
const REPO_SCOPED_FLAGS = new Set([
  "repo",
  "review-system-prompt",
  "review-system-prompt-max-chars",
  ...DIAGRAM_FLAGS,
  "review-read-diff-max-chars",
  ...TOOL_LIMIT_FLAGS.map(([flag]) => flag),
  "mcp-config",
  "mcp-allow-forks",
  "guide-full-every",
  "review-references",
  "companions",
  "gh-concurrent",
  "ai-concurrent",
  ...REPO_TEXT_FLAGS.map(([flag]) => flag),
  ...Object.keys(REPO_DB_FLAGS),
  "remake-cron",
  "review-policy",
  "unset",
  "no-verify",
]);

/** The `--unset=name` values that address a repository-scoped field. */
const REPO_SCOPED_UNSET = new Set([
  "review-system-prompt",
  "reviewSystemPrompt",
  "review-system-prompt-max-chars",
  "reviewSystemPromptMaxChars",
  ...DIAGRAM_FLAGS,
  "diagramRuntime",
  "plantumlServer",
  "plantumlOutputFormat",
  "review-read-diff-max-chars",
  "reviewReadDiffMaxChars",
  ...TOOL_LIMIT_FLAGS.flat(),
  "mcp-config",
  "mcpServers",
  "mcp-allow-forks",
  "mcpAllowForks",
  "guide-full-every",
  "guideFullEvery",
  "gh-concurrent",
  "ghConcurrent",
  "ai-concurrent",
  "aiConcurrent",
  "review-references",
  "reviewReferences",
  "companions",
  ...REPO_TEXT_FLAGS.flat(),
  "remake-cron",
  "remakeCron",
]);

function repoTextProblem(flag: string, value: string): string | undefined {
  if (flag === "ai") {
    rejectRetiredProvider(value);
    if (!(AI_PROVIDERS as readonly string[]).includes(value)) {
      return `--ai must be one of: ${AI_PROVIDERS.join(", ")}`;
    }
  }
  if (flag === "auth" && !["gh", "pat"].includes(value)) {
    return "--auth must be gh or pat";
  }
  if (flag === "review-event" && !["auto", "comment"].includes(value)) {
    return "--review-event must be auto or comment";
  }
  if (flag === "review-blocking" && !["model", "severity"].includes(value)) {
    return "--review-blocking must be model or severity";
  }
  if (
    flag === "only-request-changed-pr" &&
    !["true", "false"].includes(value)
  ) {
    return "--only-request-changed-pr must be true or false with --repo";
  }
  if (flag === "review-exclude") {
    const problem = excludePatternError(value);
    if (problem) return `--review-exclude: ${problem}`;
  }
  return undefined;
}

/** `set --repo=owner/repo [--review-system-prompt=... | --review-system-prompt-max-chars=N | --review-read-diff-max-chars=N | --review-tool-result-max-chars=N | --review-tool-budget-chars=N | --review-search-max-context-lines=N | --mcp-config=PATH | --mcp-allow-forks=true|false | --unset=name]`
 * writes the repository-scoped settings to `repos[owner/repo]` in config.json
 * instead of the global config. */
async function runSetRepo(typed: string, args: string[]): Promise<void> {
  if (!/^[^/]+\/[^/]+$/.test(typed)) die("--repo must look like owner/repo");
  const repo = canonicalRepoName(typed);
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2).split("=")[0]!;
    if (!REPO_SCOPED_FLAGS.has(name)) {
      die(`--${name} cannot be used with --repo`);
    }
    if (name === "unset") {
      const value = arg.slice("--unset=".length);
      if (!REPO_SCOPED_UNSET.has(value)) {
        die(`--unset=${value} cannot be used with --repo`);
      }
    }
  }
  const unset = new Set(
    args
      .filter((arg) => arg.startsWith("--unset="))
      .map((arg) => arg.slice("--unset=".length)),
  );
  const existing = readConfig().repos?.[repo] ?? {};
  const patch: RepoConfig = {};
  // Unset first, then explicit values win, so `--unset=x --x=...` sets.
  if (unset.has("review-system-prompt") || unset.has("reviewSystemPrompt")) {
    patch.reviewSystemPrompt = undefined;
  }
  if (
    unset.has("review-system-prompt-max-chars") ||
    unset.has("reviewSystemPromptMaxChars")
  ) {
    patch.reviewSystemPromptMaxChars = undefined;
  }
  if (
    unset.has("review-read-diff-max-chars") ||
    unset.has("reviewReadDiffMaxChars")
  ) {
    patch.reviewReadDiffMaxChars = undefined;
  }
  if (unset.has("gh-concurrent") || unset.has("ghConcurrent")) {
    patch.ghConcurrent = undefined;
  }
  if (unset.has("ai-concurrent") || unset.has("aiConcurrent")) {
    patch.aiConcurrent = undefined;
  }
  for (const [flag, field] of [
    ["diagram-runtime", "diagramRuntime"],
    ["plantuml-server", "plantumlServer"],
    ["plantuml-output-format", "plantumlOutputFormat"],
  ] as const) {
    if (unset.has(flag) || unset.has(field)) patch[field] = undefined;
  }
  try {
    Object.assign(
      patch,
      diagramOptionsFrom({
        runtime: text(args, "diagram-runtime"),
        server: text(args, "plantuml-server"),
        format: text(args, "plantuml-output-format"),
      }),
    );
  } catch (error) {
    if (error instanceof DiagramSettingError) die(error.message);
    throw error;
  }
  const ghRaw = text(args, "gh-concurrent");
  if (ghRaw !== undefined) {
    patch.ghConcurrent = concurrencyValue(ghRaw, "--gh-concurrent");
  }
  const aiRaw = text(args, "ai-concurrent");
  if (aiRaw !== undefined) {
    patch.aiConcurrent = concurrencyValue(aiRaw, "--ai-concurrent");
  }
  const maxRaw = text(args, "review-system-prompt-max-chars");
  if (maxRaw !== undefined) {
    // Blank clears it, the same as an empty value on the dashboard form.
    if (maxRaw.trim() === "") {
      patch.reviewSystemPromptMaxChars = undefined;
    } else {
      const value = Number(maxRaw);
      if (!Number.isInteger(value)) {
        die(
          "--review-system-prompt-max-chars must be an integer (0 or -1 for no limit)",
        );
      }
      patch.reviewSystemPromptMaxChars = value;
    }
  }
  const readDiffRaw = text(args, "review-read-diff-max-chars");
  if (readDiffRaw !== undefined) {
    if (readDiffRaw.trim() === "") {
      patch.reviewReadDiffMaxChars = undefined;
    } else {
      const value = Number(readDiffRaw);
      if (!Number.isInteger(value)) {
        die(
          "--review-read-diff-max-chars must be an integer (0 or -1 for no limit)",
        );
      }
      patch.reviewReadDiffMaxChars = value;
    }
  }
  for (const [flag, field] of TOOL_LIMIT_FLAGS) {
    if (unset.has(flag) || unset.has(field)) patch[field] = undefined;
    const raw = text(args, flag);
    if (raw === undefined) continue;
    if (raw.trim() === "") {
      patch[field] = undefined;
      continue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      die(`--${flag} must be an integer (0 or -1 for no limit)`);
    }
    patch[field] = value;
  }
  if (unset.has("mcp-config") || unset.has("mcpServers")) {
    patch.mcpServers = undefined;
  }
  const mcpFile = text(args, "mcp-config");
  if (mcpFile !== undefined) {
    // The cloud sets the switch from outside the container, so a stored
    // config can never turn MCP back on there.
    if (mcpDisabled()) die(MCP_DISABLED_MESSAGE);
    let read: { text: string; cut: boolean };
    try {
      read = await readTextFileCapped(mcpFile, MCP_CONFIG_MAX_BYTES);
    } catch (error) {
      die(`Could not read the MCP config ${mcpFile}: ${String(error)}`);
    }
    if (read.cut) {
      die(
        `The MCP config ${mcpFile} is over ${MCP_CONFIG_MAX_BYTES / 1024 / 1024} MB.`,
      );
    }
    const raw = read.text;
    try {
      patch.mcpServers = parseMcpConfig(raw);
    } catch (error) {
      if (error instanceof McpConfigError) {
        die(`--mcp-config: ${error.message}`);
      }
      throw error;
    }
  }
  if (unset.has("mcp-allow-forks") || unset.has("mcpAllowForks")) {
    patch.mcpAllowForks = undefined;
  }
  const allowForks = text(args, "mcp-allow-forks");
  if (allowForks !== undefined) {
    if (!["true", "false"].includes(allowForks)) {
      die("--mcp-allow-forks must be true or false");
    }
    patch.mcpAllowForks = allowForks === "true";
  }
  if (unset.has("guide-full-every") || unset.has("guideFullEvery")) {
    patch.guideFullEvery = undefined;
  }
  const fullEveryRaw = text(args, "guide-full-every");
  if (fullEveryRaw !== undefined) {
    if (fullEveryRaw.trim() === "") {
      patch.guideFullEvery = undefined;
    } else {
      const value = Number(fullEveryRaw);
      if (!Number.isInteger(value) || value < 0) {
        die(
          "--guide-full-every must be a whole number: 1 always rewrites the guide, 0 never does after init",
        );
      }
      patch.guideFullEvery = value;
    }
  }
  if (unset.has("review-references") || unset.has("reviewReferences")) {
    patch.reviewReferences = undefined;
  }
  const references = text(args, "review-references");
  if (references !== undefined) {
    if (!["on", "off"].includes(references)) {
      die("--review-references must be on or off");
    }
    patch.reviewReferences = references === "on";
    if (references === "on" && !existing.referencesBackfilledAt) {
      console.log(
        "[set] the next sync reads every pull request again once, so guide rules get links to the review comments they came from",
      );
    }
  }
  if (unset.has("companions")) patch.companions = undefined;
  const companions = text(args, "companions");
  if (companions !== undefined) {
    try {
      patch.companions = parseCompanionsSetting(companions, repo);
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  }
  const prompt = text(args, "review-system-prompt");
  if (prompt !== undefined) {
    patch.reviewSystemPrompt = prompt.trim() === "" ? undefined : prompt;
  }
  for (const [flag, field] of REPO_TEXT_FLAGS) {
    if (unset.has(flag) || unset.has(field)) patch[field] = undefined;
    const raw = text(args, flag);
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value === "") {
      patch[field] = undefined;
      continue;
    }
    const problem = repoTextProblem(flag, value);
    if (problem) die(problem);
    (patch as Record<string, unknown>)[field] =
      flag === "only-request-changed-pr" ? value === "true" : value;
  }
  if (unset.has("remake-cron") || unset.has("remakeCron")) {
    patch.remakeCron = undefined;
    patch.remakeCronDraft = undefined;
  }
  const cron = text(args, "remake-cron");
  if (cron !== undefined) {
    if (cron.trim() === "") {
      patch.remakeCron = undefined;
    } else {
      try {
        parseRemakeCron(cron);
      } catch (error) {
        die(
          `--remake-cron: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      patch.remakeCron = cron.trim();
    }
    patch.remakeCronDraft = undefined;
  }
  const dbPatch: Parameters<typeof updateRepoSettings>[1] = {};
  for (const [flag, rule] of Object.entries(REPO_DB_FLAGS)) {
    const raw = text(args, flag);
    if (raw === undefined) continue;
    if (!rule.values.includes(raw)) die(`--${flag} must be ${rule.describe}`);
    const on = raw === "on" || raw === "true";
    if (flag === "auto-review") dbPatch.auto_review = on ? 1 : 0;
    if (flag === "skip-drafts") dbPatch.skip_drafts = on ? 1 : 0;
    if (flag === "skip-bots") dbPatch.skip_bots = on ? 1 : 0;
    if (flag === "codegraph") dbPatch.use_codegraph = on ? 1 : 0;
    if (flag === "watch-open-issues") dbPatch.watch_open_issues = on ? 1 : 0;
    if (flag === "review-scope") {
      dbPatch.review_scope = raw as "whole-pr" | "incremental";
    }
    if (flag === "watch-push-mode") {
      dbPatch.watch_push_mode = raw as "queue" | "cancel-and-merge";
    }
  }
  const repoPolicy = text(args, "review-policy");
  if (repoPolicy !== undefined) {
    if (repoPolicy === "legacy") {
      dbPatch.review_policy_json = '"legacy"';
    } else {
      const checked = parsePolicy(repoPolicy);
      if (!checked.ok) die(`--review-policy: ${checked.problem}`);
      dbPatch.review_policy_json = JSON.stringify(repoPolicy);
    }
  }
  if (Object.keys(dbPatch).length > 0) {
    const switches =
      dbPatch.auto_review !== undefined ||
      dbPatch.skip_drafts !== undefined ||
      dbPatch.skip_bots !== undefined;
    const written = await withAppDb((): "missing" | "policy" | "ok" => {
      const row = getRepo(repo);
      if (!row) return "missing";
      // The same rule as the dashboard: the simple switches only apply when
      // the repository uses no review policy.
      const policy = dbPatch.review_policy_json ?? row.review_policy_json;
      if (switches && policy !== null && policy !== '"legacy"') return "policy";
      if (switches) dbPatch.review_policy_json = '"legacy"';
      updateRepoSettings(repo, dbPatch);
      return "ok";
    });
    if (!written.ok)
      die(`Could not write the dashboard settings: ${written.reason}`);
    if (written.value === "missing") {
      die(
        `${repo} is not on the dashboard yet. Run init for it, or add it from the dashboard first.`,
      );
    }
    if (written.value === "policy") {
      die(
        `${repo} uses a review policy, so --auto-review, --skip-drafts and --skip-bots do not apply. Pass --review-policy=legacy first, or change the policy.`,
      );
    }
    console.log(
      `[set] updated ${repo} on the dashboard: ${Object.entries(dbPatch)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(", ")}`,
    );
    if (Object.keys(patch).length === 0) return;
  }
  if (Object.keys(patch).length === 0) {
    die(
      "Nothing to set. Pass --review-system-prompt=, --review-system-prompt-max-chars=N, --diagram-runtime=, --plantuml-server=, --plantuml-output-format=, --review-read-diff-max-chars=N, --review-tool-result-max-chars=N, --review-tool-budget-chars=N, --review-search-max-context-lines=N, --mcp-config=PATH, --mcp-allow-forks=true|false, --guide-full-every=N, --review-references=on|off, --companions=owner/repo,..., --ai=, --low-model=, --high-model=, --auth=, --review-blocking=, --review-exclude=, --only-request-changed-pr=true|false, or --unset=name with --repo.",
    );
  }
  // The values after this write are the ones given here, or the stored ones.
  // Lowering the cap re-checks the stored prompt too, so it cannot end up over
  // the cap it is measured against.
  const effectiveMax =
    "reviewSystemPromptMaxChars" in patch
      ? patch.reviewSystemPromptMaxChars
      : existing.reviewSystemPromptMaxChars;
  const effectivePrompt =
    "reviewSystemPrompt" in patch
      ? patch.reviewSystemPrompt
      : existing.reviewSystemPrompt;
  if (effectivePrompt !== undefined) {
    const problem = checkReviewSystemPrompt(
      effectivePrompt,
      reviewSystemPromptLimit({ reviewSystemPromptMaxChars: effectiveMax }),
    );
    if (problem) die(`--review-system-prompt: ${problem}`);
  }
  await writeRepoConfig(repo, patch);
  // MCP servers print by name and tool: their command and env may hold
  // secrets.
  const summary = Object.entries(patch).map(([key, value]) =>
    value === undefined
      ? `${key} (unset)`
      : key === "mcpServers"
        ? `${key}=${mcpServersSummary(patch.mcpServers!)}`
        : `${key}=${value}`,
  );
  console.log(`[set] updated ${repo}: ${summary.join(", ")}`);
  console.log(`Saved to ${configPath()}`);
}
