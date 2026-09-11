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
    if ("webhookUrl" in body) {
      const webhookError = validateWebhookUrl(body.webhookUrl);
      if (webhookError) {
        return errorResponse(400, "invalid_webhook_url", webhookError);
      }
      patch.webhookUrl = (body.webhookUrl as string).trim();
    }
    if (body.defaults && typeof body.defaults === "object") {
      const defaults = body.defaults as Record<string, unknown>;
      patch.defaults = {
        ...current.defaults,
        ...Object.fromEntries(
          Object.entries(defaults).filter(([, value]) =>
            value !== "" && value !== null && value !== undefined
          ),
        ),
      };
    }
    const merged = { ...current, ...patch };
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
