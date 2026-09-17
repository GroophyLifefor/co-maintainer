import { errorResponse } from "../errors.ts";
import { readConfig, writeUserConfig } from "../../config.ts";
import type { UserConfig } from "../../config.ts";
import { testAppAccess, testGithubAccess } from "../../services/credentials.ts";

function validateWebhookUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return "webhook URL is required";
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "webhook URL must use http or https";
    }
  } catch {
    return "webhook URL must be an absolute http(s) URL";
  }
  return undefined;
}

export async function handleSettingsRoute(
  request: Request,
  url: URL,
  webhookUrl: string,
): Promise<Response> {
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
      webhookUrl: config.webhookUrl || webhookUrl,
      githubOAuthClientId: config.githubOAuthClientId ?? "",
      hasOAuthClientSecret: Boolean(config.githubOAuthClientSecret),
      githubOAuthAllowedUser: config.githubOAuthAllowedUser ?? "",
      passwordAuthDisabled: Boolean(config.passwordAuthDisabled),
      githubAuthEnabled: Boolean(config.githubAuthEnabled),
      maxConcurrentJobs: config.maxConcurrentJobs ?? null,
      remoteSyncTimeoutSeconds: config.remoteSyncTimeoutSeconds ?? null,
      maxConcurrentRemoteReviewsPerToken:
        config.maxConcurrentRemoteReviewsPerToken ?? null,
      remoteToolOutputMaxChars: config.remoteToolOutputMaxChars ?? null,
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
      (!merged.githubOAuthClientId || !merged.githubOAuthClientSecret ||
        !merged.githubOAuthAllowedUser)
    ) {
      return errorResponse(
        422,
        "oauth_incomplete",
        "GitHub sign-in needs a client ID, client secret, and allowed username",
      );
    }
    const touchingGithub = patch.auth !== undefined ||
      patch.githubPat !== undefined;
    const touchingApp = patch.githubAppId !== undefined ||
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
        privateKeyPem: merged.githubAppPrivateKey ?? "",
      });
      if (!app.ok) {
        return errorResponse(422, "app_access", app.message);
      }
    }
    await writeUserConfig(patch);
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
      privateKeyPem: config.githubAppPrivateKey ?? "",
    });
    return Response.json({
      ai: { ok: Boolean(config.ai && config.ai !== "none" && config.token) },
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
