/** `createApp(deps).fetch(request)` — no port, no sockets, so it is testable
 * with a plain `Request`. */
import { VERSION } from "../version.ts";
import { errorResponse } from "./errors.ts";
import {
  hasCsrfHeader,
  login,
  logout,
  readSessionToken,
  sessionCookieHeader,
  verifySession,
} from "./auth.ts";
import { memoryPasswordStore } from "./auth.ts";
import { clientAddress, forwardedHttps } from "./proxy_headers.ts";
import type { AuthMethods, PasswordStore } from "./auth.ts";
import { readConfig } from "../config.ts";
import { listJobs } from "../store/jobs.ts";
import { handleJobsRoute } from "./api/jobs.ts";
import { handleReposRoute } from "./api/repos.ts";
import { handleInstallationsRoute } from "./api/installations.ts";
import { handleSettingsRoute } from "./api/settings.ts";
import { handleActivityRoute } from "./api/activity.ts";
import { handleAnalyticsRoute } from "./api/analytics.ts";
import { handleRemoteTokensRoute } from "./api/remote_tokens.ts";
import { handleRemoteRoute } from "../remote/server/routes.ts";
import { handleWebhookRequest } from "./webhook/index.ts";
import { handlePageRequest } from "./pages/router.ts";

/** `password` seeds an in-memory store. `serve` passes `passwordStore` so the
 * password lives in config.json instead. */
export type AppDeps = {
  password: string;
  passwordStore?: PasswordStore;
  webhookUrl?: string;
  secureCookie?: boolean;
  /** Behind a reverse proxy this process trusts, the client address and the
   * scheme come from `x-forwarded-for` and `x-forwarded-proto`. */
  trustProxy?: boolean;
  inject500?: boolean;
  /** Defaults to password-only when omitted, matching every caller that
   * pre-dates GitHub sign-in. */
  auth?: AuthMethods;
  githubOAuth?: { clientId: string; clientSecret: string; allowedUser: string };
};

export type App = {
  fetch(request: Request, remoteAddr?: string): Promise<Response>;
};

function setupStatus() {
  const config = readConfig();
  const ai = Boolean(config.ai && config.ai !== "none" && config.token);
  const github = Boolean(
    config.auth === "gh" || (config.auth === "pat" && config.githubPat),
  );
  const app = Boolean(config.githubAppId && config.githubAppPrivateKey);
  const missing = [
    !ai && "ai",
    !github && "github",
    !app && "github app",
  ].filter((item): item is string => Boolean(item));
  return { setup: { ai, github, app }, missing };
}

async function requireSession(
  request: Request,
): Promise<{ username: string } | undefined> {
  const token = readSessionToken(request);
  if (!token) return undefined;
  return await verifySession(token);
}

async function handleLogin(
  request: Request,
  deps: AppDeps,
  passwords: PasswordStore,
  ip: string,
): Promise<Response> {
  if (deps.auth?.password === false) {
    return errorResponse(
      403,
      "password_disabled",
      "password sign-in is disabled",
    );
  }
  let body: { password?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "bad_request", "expected a JSON body");
  }
  const result = await login(String(body.password ?? ""), passwords, ip);
  if (!result) return errorResponse(401, "unauthorized", "wrong password");
  return Response.json(result, {
    headers: {
      "set-cookie": sessionCookieHeader(
        result.token,
        Boolean(deps.secureCookie),
      ),
    },
  });
}

async function handleLogout(request: Request): Promise<Response> {
  const token = readSessionToken(request);
  if (token) await logout(token);
  return new Response(null, { status: 204 });
}

function health(): Response {
  let queue = { queued: 0, running: 0 };
  let db = "ok";
  try {
    queue = {
      queued: listJobs({ status: "queued" }).length,
      running: listJobs({ status: "running" }).length,
    };
  } catch {
    db = "unavailable";
  }
  return Response.json({
    ok: true,
    version: VERSION,
    queue,
    db,
  });
}

/** Read per request so credentials saved from the dashboard take effect
 * without restarting `serve`. */
function liveGithubConfig() {
  const config = readConfig();
  return {
    githubApp:
      config.githubAppId && config.githubAppPrivateKey
        ? {
            appId: config.githubAppId,
            privateKeyPem: config.githubAppPrivateKey,
          }
        : undefined,
    webhookSecret: config.githubWebhookSecret,
  };
}

export function createApp(deps: AppDeps): App {
  const passwords = deps.passwordStore ?? memoryPasswordStore(deps.password);
  return {
    async fetch(
      request: Request,
      socketAddress = "unknown",
    ): Promise<Response> {
      const url = new URL(request.url);
      const remoteAddr = deps.trustProxy
        ? clientAddress(request, socketAddress)
        : socketAddress;
      const secureCookie =
        Boolean(deps.secureCookie) ||
        (Boolean(deps.trustProxy) && forwardedHttps(request));
      const { githubApp, webhookSecret } = liveGithubConfig();
      const mutating = ["POST", "PATCH", "PUT", "DELETE"].includes(
        request.method,
      );

      if (url.pathname === "/api/health" && request.method === "GET") {
        return health();
      }

      if (url.pathname === "/github/webhook" && request.method === "POST") {
        return await handleWebhookRequest(request, webhookSecret);
      }

      const page = await handlePageRequest(
        request,
        { ...deps, githubApp, passwordStore: passwords, secureCookie },
        remoteAddr,
      );
      if (page) return page;

      if (url.pathname.startsWith("/api/remote/")) {
        return await handleRemoteRoute(request, url, remoteAddr);
      }

      if (url.pathname.startsWith("/api/")) {
        if (mutating && !hasCsrfHeader(request)) {
          return errorResponse(
            403,
            "csrf",
            `every mutating request needs the X-Requested-With header`,
          );
        }

        if (url.pathname === "/api/login" && request.method === "POST") {
          return await handleLogin(
            request,
            { ...deps, secureCookie },
            passwords,
            remoteAddr,
          );
        }

        const session = await requireSession(request);
        if (!session) {
          return errorResponse(401, "unauthorized", "sign in required");
        }

        if (deps.inject500 && mutating && url.pathname !== "/api/login") {
          return errorResponse(500, "injected", "The request failed.");
        }

        if (url.pathname === "/api/logout" && request.method === "POST") {
          return await handleLogout(request);
        }
        if (url.pathname === "/api/me" && request.method === "GET") {
          return Response.json({
            username: session.username,
            ...setupStatus(),
          });
        }
        if (url.pathname.startsWith("/api/jobs")) {
          return handleJobsRoute(request, url);
        }
        if (url.pathname.startsWith("/api/repos")) {
          return await handleReposRoute(request, url, githubApp);
        }
        if (url.pathname === "/api/installations") {
          return await handleInstallationsRoute(request, githubApp);
        }
        if (url.pathname.startsWith("/api/settings")) {
          return await handleSettingsRoute(
            request,
            url,
            deps.webhookUrl ?? "",
            passwords,
            remoteAddr,
          );
        }
        if (url.pathname.startsWith("/api/activity")) {
          return handleActivityRoute(request, url);
        }
        if (url.pathname === "/api/analytics") {
          return handleAnalyticsRoute(request, url);
        }
        if (url.pathname.startsWith("/api/remote-tokens")) {
          return await handleRemoteTokensRoute(request, url);
        }

        return errorResponse(404, "not_found", `no route for ${url.pathname}`);
      }

      return errorResponse(404, "not_found", `no route for ${url.pathname}`);
    },
  };
}
