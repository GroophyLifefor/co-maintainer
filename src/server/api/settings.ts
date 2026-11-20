import {
  liveWebhookUrl,
  type WebhookUrlSource,
  webhookUrlProblem,
} from "../webhook_url.ts";
import { errorResponse } from "../errors.ts";
import { verifyAiKey } from "../../ai/verify.ts";
import { getEnv } from "../../util/runtime.ts";
import {
  readConfig,
  resolveAppPrivateKey,
  resolvedAiToken,
  writeUserConfig,
} from "../../config.ts";
import {
  aiConfigured,
  savedKeyProvider,
  type UserConfig,
} from "../../config.ts";
import { testAppAccess, testGithubAccess } from "../../services/credentials.ts";
import {
  GLOBAL_REASONING_EFFORTS,
  globalReasoningEffort,
  isGlobalReasoningEffort,
} from "../../ai/reasoning.ts";
import {
  checkPassword,
  readSessionToken,
  revokeOtherSessions,
} from "../auth.ts";
import type { PasswordStore } from "../auth.ts";
import { passwordProblem } from "../../util/password.ts";
import { readJsonObject } from "./json_body.ts";
import { policyToStore } from "../../services/review_policy.ts";
import {
  audit,
  settingChanges,
  settingsSnapshot,
} from "../../services/audit.ts";

/** Settings the dashboard may clear with an explicit `clear` entry. */
const CLEARABLE = new Set([
  "token",
  "githubPat",
  "githubAppPrivateKey",
  "githubWebhookSecret",
  "githubOAuthClientSecret",
  "lowModel",
  "highModel",
  "githubAppId",
  "githubOAuthClientId",
  "githubOAuthAllowedUser",
]);

function validateWebhookUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return "webhook URL is required";
  }
  // The same checks `serve` runs at start, so a saved URL cannot stop the
  // next start.
  return webhookUrlProblem(value);
}

async function changePassword(
  request: Request,
  passwords: PasswordStore,
  ip: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const next = typeof body.newPassword === "string" ? body.newPassword : "";
  const problem = passwordProblem(next);
  if (problem) return errorResponse(422, "weak_password", problem);
  const current = String(body.currentPassword ?? "");
  if (!(await checkPassword(current, passwords, ip))) {
    return errorResponse(
      403,
      "wrong_password",
      "the current password is wrong",
    );
  }
  await passwords.set(next);
  audit("settings", "Changed the dashboard password");
  const token = readSessionToken(request);
  if (token) await revokeOtherSessions(token);
  return Response.json({ ok: true });
}

export async function handleSettingsRoute(
  request: Request,
  url: URL,
  webhook: string | WebhookUrlSource,
  passwords: PasswordStore,
  ip: string,
): Promise<Response> {
  if (url.pathname === "/api/settings/password" && request.method === "POST") {
    return await changePassword(request, passwords, ip);
  }
  if (url.pathname === "/api/settings" && request.method === "GET") {
    const config = readConfig();
    return Response.json({
      auth: config.auth ?? "gh",
      ai: config.ai ?? "none",
      lowModel: config.lowModel ?? "",
      highModel: config.highModel ?? "",
      githubAppId: config.githubAppId ?? "",
      defaults: config.defaults ?? {},
      hasAiToken: Boolean(config.token),
      hasPat: Boolean(config.githubPat),
      hasAppKey: Boolean(config.githubAppPrivateKey),
      hasWebhookSecret: Boolean(config.githubWebhookSecret),
      webhookUrl: liveWebhookUrl(config, webhook),
      webhookUrlLockedBy:
        typeof webhook === "object" && webhook.webhookUrlOverride
          ? (webhook.webhookUrlOverrideName ?? "--webhook-url")
          : null,
      githubOAuthClientId: config.githubOAuthClientId ?? "",
      hasOAuthClientSecret: Boolean(config.githubOAuthClientSecret),
      githubOAuthAllowedUser: config.githubOAuthAllowedUser ?? "",
      passwordAuthDisabled: Boolean(config.passwordAuthDisabled),
      githubAuthEnabled: Boolean(config.githubAuthEnabled),
      maxConcurrentJobs: config.maxConcurrentJobs ?? null,
      aiTimeoutMinutes: config.aiTimeoutMinutes ?? null,
      globalReasoningEffort: globalReasoningEffort(config),
      remoteSyncTimeoutSeconds: config.remoteSyncTimeoutSeconds ?? null,
      maxConcurrentRemoteReviewsPerToken:
        config.maxConcurrentRemoteReviewsPerToken ?? null,
      remoteToolOutputMaxChars: config.remoteToolOutputMaxChars ?? null,
      reviewPolicy: config.reviewPolicy ?? null,
    });
  }

  if (url.pathname === "/api/settings" && request.method === "PUT") {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "bad_request", "expected a JSON body");
    }
    const current = readConfig();
    const patch: Partial<UserConfig> = {};
    const text = (key: keyof UserConfig) => {
      const value = body[key];
      if (typeof value !== "string") return;
      if (value === "") return;
      (patch as Record<string, unknown>)[key] = value;
    };
    text("auth");
    text("ai");
    text("lowModel");
    text("highModel");
    text("token");
    text("githubPat");
    text("githubAppId");
    text("githubAppPrivateKey");
    text("githubWebhookSecret");
    text("githubOAuthClientId");
    text("githubOAuthClientSecret");
    text("githubOAuthAllowedUser");
    // An emptied field clears its value. Secrets are never shown in a field,
    // so an empty secret field means "keep it" and clearing one is an
    // explicit `clear` entry, sent by its Remove button.
    for (const key of [
      "lowModel",
      "highModel",
      "githubAppId",
      "githubOAuthClientId",
      "githubOAuthAllowedUser",
    ] as const) {
      if (body[key] === "" && current[key] !== undefined)
        patch[key] = undefined;
    }
    if (Array.isArray(body.clear)) {
      for (const key of body.clear) {
        if (typeof key !== "string" || !CLEARABLE.has(key)) {
          return errorResponse(
            422,
            "invalid_setting",
            `${String(key)} cannot be cleared here`,
          );
        }
        (patch as Record<string, unknown>)[key] = undefined;
      }
    }
    // A key means nothing without the provider it belongs to: saving one
    // with no provider would read "A key is saved" next to "Not set".
    const provider = patch.ai ?? current.ai;
    if (patch.token && (!provider || provider === "none")) {
      return errorResponse(
        422,
        "provider_required",
        "Choose a provider before saving an API key.",
      );
    }
    const previousAi = savedKeyProvider(current);
    if (
      patch.ai &&
      patch.ai !== "none" &&
      patch.ai !== previousAi &&
      !patch.token &&
      current.token
    ) {
      return errorResponse(
        422,
        "key_for_other_provider",
        `The saved key is for ${previousAi}. Enter the ${patch.ai} key to switch providers.`,
      );
    }
    if ("remoteByokPolicy" in body) {
      const policy = body.remoteByokPolicy;
      if (policy !== "off" && policy !== "allow" && policy !== "require") {
        return errorResponse(
          422,
          "invalid_setting",
          "remoteByokPolicy must be off, allow or require",
        );
      }
      patch.remoteByokPolicy = policy;
    }
    // The server default the setup wizard saves. A repository's own rule
    // still wins.
    if ("reviewBlocking" in body) {
      const blocking = body.reviewBlocking;
      if (blocking !== "model" && blocking !== "severity") {
        return errorResponse(
          422,
          "invalid_setting",
          "reviewBlocking must be model or severity",
        );
      }
      patch.reviewBlocking = blocking;
    }
    if (typeof body.passwordAuthDisabled === "boolean") {
      patch.passwordAuthDisabled = body.passwordAuthDisabled;
    }
    if (typeof body.githubAuthEnabled === "boolean") {
      patch.githubAuthEnabled = body.githubAuthEnabled;
    }
    if ("webhookUrl" in body) {
      const webhookError = validateWebhookUrl(body.webhookUrl);
      if (webhookError) {
        return errorResponse(400, "invalid_webhook_url", webhookError);
      }
      patch.webhookUrl = (body.webhookUrl as string).trim();
    }
    if ("maxConcurrentJobs" in body) {
      const raw = body.maxConcurrentJobs;
      if (raw === null || raw === "") {
        patch.maxConcurrentJobs = undefined;
      } else if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
        patch.maxConcurrentJobs = raw;
      } else {
        return errorResponse(
          422,
          "invalid_setting",
          "maxConcurrentJobs must be a positive integer or null",
        );
      }
    }
    const positiveIntOrNull = (
      key: keyof UserConfig,
      label: string,
    ): Response | void => {
      if (!(key in body)) return;
      const raw = body[key as string];
      if (raw === null || raw === "") {
        (patch as Record<string, unknown>)[key] = undefined;
        return;
      }
      if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
        (patch as Record<string, unknown>)[key] = raw;
        return;
      }
      return errorResponse(
        422,
        "invalid_setting",
        `${label} must be a positive integer or null`,
      );
    };
    const remoteTimeout = positiveIntOrNull(
      "remoteSyncTimeoutSeconds",
      "remoteSyncTimeoutSeconds",
    );
    if (remoteTimeout) return remoteTimeout;
    const remotePerToken = positiveIntOrNull(
      "maxConcurrentRemoteReviewsPerToken",
      "maxConcurrentRemoteReviewsPerToken",
    );
    if (remotePerToken) return remotePerToken;
    const remoteToolOut = positiveIntOrNull(
      "remoteToolOutputMaxChars",
      "remoteToolOutputMaxChars",
    );
    if (remoteToolOut) return remoteToolOut;
    const aiTimeout = positiveIntOrNull("aiTimeoutMinutes", "aiTimeoutMinutes");
    if (aiTimeout) return aiTimeout;
    if ("globalReasoningEffort" in body) {
      const level = body.globalReasoningEffort;
      if (level === null || level === "") {
        patch.globalReasoningEffort = undefined;
      } else if (isGlobalReasoningEffort(level)) {
        patch.globalReasoningEffort = level;
      } else {
        return errorResponse(
          422,
          "invalid_setting",
          `globalReasoningEffort must be one of ${GLOBAL_REASONING_EFFORTS.join(", ")}`,
        );
      }
    }
    if ("reviewPolicy" in body) {
      const stored = policyToStore(body.reviewPolicy, { allowLegacy: false });
      if (!stored.ok) {
        return errorResponse(422, "invalid_policy", stored.problem);
      }
      patch.reviewPolicy =
        stored.value === null ? undefined : JSON.parse(stored.value);
    }
    if (body.defaults && typeof body.defaults === "object") {
      const defaults = body.defaults as Record<string, unknown>;
      const next = { ...current.defaults };
      const intKeys = [
        "maxPrMonths",
        "maxCommits",
        "maxPullRequestChangeLines",
      ] as const;
      const intKeySet = new Set<string>(intKeys);
      for (const key of intKeys) {
        if (!(key in defaults)) continue;
        const raw = defaults[key];
        if (raw === null || raw === "") {
          delete next[key];
          continue;
        }
        if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
          next[key] = raw;
          continue;
        }
        return errorResponse(
          422,
          "invalid_setting",
          `${key} must be a positive integer or null`,
        );
      }
      for (const [key, value] of Object.entries(defaults)) {
        if (intKeySet.has(key)) continue;
        if (value === "" || value === null || value === undefined) continue;
        (next as Record<string, unknown>)[key] = value;
      }
      patch.defaults = next;
    }
    const merged = { ...current, ...patch };
    if (merged.passwordAuthDisabled && !merged.githubAuthEnabled) {
      return errorResponse(
        422,
        "no_auth_method",
        "at least one sign-in method is required",
      );
    }
    if (
      merged.githubAuthEnabled &&
      (!merged.githubOAuthClientId ||
        !merged.githubOAuthClientSecret ||
        !merged.githubOAuthAllowedUser)
    ) {
      return errorResponse(
        422,
        "oauth_incomplete",
        "GitHub sign-in needs a client ID, client secret, and allowed username",
      );
    }
    const touchingGithub =
      patch.auth !== undefined || patch.githubPat !== undefined;
    const touchingApp =
      patch.githubAppId !== undefined ||
      patch.githubAppPrivateKey !== undefined;
    if (touchingGithub) {
      const github = await testGithubAccess({
        auth: merged.auth === "pat" ? "pat" : "gh",
        githubPat: merged.githubPat,
      });
      if (!github.ok) {
        return errorResponse(422, "github_access", github.message);
      }
    }
    if (touchingApp) {
      const app = await testAppAccess({
        appId: merged.githubAppId ?? "",
        privateKeyPem: resolveAppPrivateKey(merged) ?? "",
      });
      if (!app.ok) {
        return errorResponse(422, "app_access", app.message);
      }
    }
    // The provider check `set` runs before it saves, so a key or model the
    // CLI refuses is refused here too. An unreachable provider saves anyway,
    // as `set` does. The fake AI used by tests has no provider to ask.
    const touchingAi =
      patch.token !== undefined ||
      patch.ai !== undefined ||
      patch.highModel !== undefined;
    const aiProvider = merged.ai;
    if (
      touchingAi &&
      aiProvider &&
      aiProvider !== "none" &&
      getEnv("CM_FAKE_AI") !== "1"
    ) {
      const key = resolvedAiToken(merged, aiProvider);
      if (key) {
        const result = await verifyAiKey(aiProvider, key, merged.highModel);
        if (result.status === "rejected") {
          return errorResponse(422, "ai_rejected", result.error.message);
        }
      }
    }
    // A changed allowed user or sign-in method must not leave old dashboard
    // sessions valid, the same as `set` does.
    const credentialChanged =
      ("passwordAuthDisabled" in patch &&
        Boolean(patch.passwordAuthDisabled) !==
          Boolean(current.passwordAuthDisabled)) ||
      ("githubAuthEnabled" in patch &&
        Boolean(patch.githubAuthEnabled) !==
          Boolean(current.githubAuthEnabled)) ||
      ("githubOAuthAllowedUser" in patch &&
        patch.githubOAuthAllowedUser !== current.githubOAuthAllowedUser);
    if (credentialChanged)
      patch.credentialsChangedAt = new Date().toISOString();
    const before = settingsSnapshot();
    await writeUserConfig(patch);
    const changes = settingChanges(before, settingsSnapshot());
    if (changes.length > 0) {
      audit("settings", "Changed settings", { changes });
    }
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/settings/test" && request.method === "POST") {
    const config = readConfig();
    const github = await testGithubAccess({
      auth: config.auth === "pat" ? "pat" : "gh",
      githubPat: config.githubPat,
    });
    const app = await testAppAccess({
      appId: config.githubAppId ?? "",
      privateKeyPem: resolveAppPrivateKey(config) ?? "",
    });
    // The same provider check `set` runs, not only "a key is there".
    let ai: { ok: boolean; message?: string } = { ok: aiConfigured(config) };
    if (ai.ok && config.ai && getEnv("CM_FAKE_AI") !== "1") {
      const result = await verifyAiKey(
        config.ai,
        resolvedAiToken(config) ?? "",
        config.highModel,
      );
      if (result.status === "rejected") {
        ai = { ok: false, message: result.error.message };
      } else if (result.status === "unreachable") {
        ai = {
          ok: true,
          message: `could not reach the provider: ${result.reason}`,
        };
      }
    }
    return Response.json({
      ai,
      github: github.ok
        ? { ok: true, login: github.login }
        : { ok: false, message: github.message },
      app: app.ok
        ? { ok: true, installations: app.installations }
        : { ok: false, message: app.message },
    });
  }

  return errorResponse(404, "not_found", `no route for ${url.pathname}`);
}
