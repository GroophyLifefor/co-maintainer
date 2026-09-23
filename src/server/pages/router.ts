import {
  clearOauthStateCookieHeader,
  clearSessionCookieHeader,
  createSession,
  login,
  logout,
  oauthStateCookieHeader,
  randomToken,
  readOauthState,
  readSessionToken,
  sessionCookieHeader,
  verifySession,
} from "../auth.ts";
import type { AuthMethods, PasswordStore } from "../auth.ts";
import { githubAuthorizeUrl, githubLoginFromCode } from "../../github/oauth.ts";
import { handleClient, handleLogo, handleStyles } from "../assets.ts";
import {
  activityFeed,
  listReposForHome,
  prDetail,
  repoKnowledge,
  RepoNotFound,
  repoOverview,
  repoPulls,
  repoRemoteReviews,
  runningJobs,
  skippedDeliveries,
  statsForRange,
} from "../../services/dashboard.ts";
import { escapeHtml, html, money } from "./layout.ts";
import { readConfig, writeUserConfig } from "../../config.ts";
import type { UserConfig } from "../../config.ts";
import {
  appNameProblem,
  beginManifestState,
  buildAppManifest,
  consumeManifestState,
  convertManifest,
} from "../../github/app_manifest.ts";
import { renderHome, renderLogin } from "./home.ts";
import { renderSetup } from "./setup.ts";
import { renderAddRepo } from "./add_repo.ts";
import { renderRepo } from "./repo.ts";
import { renderRepoPulls } from "./repo_prs.ts";
import { renderRepoRemote } from "./repo_remote.ts";
import { renderPr } from "./pr.ts";
import { renderKnowledge } from "./knowledge.ts";
import { renderRepoSettings } from "./repo_settings.ts";
import { renderActivity, renderJob } from "./activity.ts";
import { renderAnalytics } from "./analytics.ts";
import { renderSettings } from "./settings.ts";
import { getRepo } from "../../store/repos.ts";
import { getJob } from "../../store/jobs.ts";
import { getLogsSince } from "../../services/jobs.ts";
import { listInstallationsWithRepos, listOpenPulls } from "../../github/app.ts";
import type { OpenPull } from "../../github/app.ts";
import { setupChecklist } from "../../services/setup_checklist.ts";

export type PageDeps = {
  passwordStore: PasswordStore;
  webhookUrl?: string;
  secureCookie?: boolean;
  githubApp?: { appId: string; privateKeyPem: string };
  auth?: AuthMethods;
  githubOAuth?: { clientId: string; clientSecret: string; allowedUser: string };
  /** Behind a reverse proxy this process trusts, absolute URLs are built
   * from `x-forwarded-host` and `x-forwarded-proto`. */
  trustProxy?: boolean;
  /** `CM_LOGIN_HINT`, shown on the sign-in page in place of the default
   * "printed when serve started" line. */
  loginHint?: string;
};

const REPO =
  /^\/repos\/([^/]+)\/([^/]+)(?:\/(pulls|knowledge|settings|remote)(?:\/(\d+))?)?$/;

/** Matches a repository page URL. Only `pulls` is keyed by a number, so a stray
 * suffix such as `/repos/o/r/remote/7` must fall through to a 404 rather than
 * render the listing and silently drop the number. */
function matchRepo(pathname: string): RegExpExecArray | null {
  const match = REPO.exec(pathname);
  if (match && match[4] && match[3] !== "pulls") return null;
  return match;
}

export async function handlePageRequest(
  request: Request,
  deps: PageDeps,
  ip: string,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/styles.css" && request.method === "GET") {
    return await handleStyles();
  }
  if (url.pathname === "/client.js" && request.method === "GET") {
    return await handleClient();
  }
  if (url.pathname === "/logo.png" && request.method === "GET") {
    return await handleLogo();
  }
  if (url.pathname === "/dashboard") {
    return Response.redirect(`${url.origin}/`, 303);
  }

  const auth = deps.auth ?? { password: true, github: false };

  if (url.pathname === "/login" && request.method === "GET") {
    const session = await sessionOf(request);
    if (session) return Response.redirect(`${url.origin}/`, 303);
    return renderLogin({
      next: safeNext(url.searchParams.get("next")),
      error: url.searchParams.get("error") ?? undefined,
      showPassword: auth.password,
      showGithub: auth.github,
      hint: deps.loginHint,
    });
  }

  if (url.pathname === "/login" && request.method === "POST") {
    return await handleLoginForm(request, deps, ip, auth);
  }

  if (url.pathname === "/auth/github" && request.method === "GET") {
    if (!auth.github || !deps.githubOAuth) {
      return new Response("GitHub sign-in is not enabled.", { status: 404 });
    }
    const next = safeNext(url.searchParams.get("next"));
    const state = randomToken();
    const authorizeUrl = githubAuthorizeUrl(
      deps.githubOAuth.clientId,
      `${url.origin}/auth/github/callback`,
      state,
    );
    return new Response(null, {
      status: 303,
      headers: {
        location: authorizeUrl,
        "set-cookie": oauthStateCookieHeader(
          state,
          next,
          Boolean(deps.secureCookie),
        ),
      },
    });
  }

  if (url.pathname === "/auth/github/callback" && request.method === "GET") {
    if (!auth.github || !deps.githubOAuth) {
      return new Response("GitHub sign-in is not enabled.", { status: 404 });
    }
    return await handleGithubCallback(request, url, deps.githubOAuth, deps);
  }

  if (url.pathname === "/logout" && request.method === "POST") {
    const token = readSessionToken(request);
    if (token) await logout(token);
    return new Response(null, {
      status: 303,
      headers: {
        location: "/login",
        "set-cookie": clearSessionCookieHeader(Boolean(deps.secureCookie)),
      },
    });
  }

  const session = await sessionOf(request);
  if (!session) {
    if (isPagePath(url.pathname)) {
      const next = encodeURIComponent(url.pathname + url.search);
      return Response.redirect(`${url.origin}/login?next=${next}`, 303);
    }
    return undefined;
  }

  const username = session.username;
  try {
    if (url.pathname === "/" && request.method === "GET") {
      const config = readConfig();
      return renderHome(
        username,
        listReposForHome().map(toHomeRow),
        setupChecklist(config.webhookUrl || deps.webhookUrl || ""),
      );
    }
    if (url.pathname === "/setup" && request.method === "GET") {
      const config = readConfig();
      return renderSetup(username, {
        ai: Boolean(config.ai && config.ai !== "none" && config.token),
        github: Boolean(
          config.auth === "gh" || (config.auth === "pat" && config.githubPat),
        ),
        app: Boolean(config.githubAppId && config.githubAppPrivateKey),
      });
    }
    if (url.pathname === "/repos/new" && request.method === "GET") {
      return renderAddRepo(username, await repoPicker(deps.githubApp));
    }
    if (url.pathname === "/github/app-manifest" && request.method === "POST") {
      return await beginAppManifest(request, url, deps);
    }
    if (
      url.pathname === "/github/app-manifest/callback" &&
      request.method === "GET"
    ) {
      return await finishAppManifest(request, url);
    }
    if (url.pathname === "/activity" && request.method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      return renderActivity(
        username,
        runningJobs(),
        activityFeed(page, 20),
        skippedDeliveries(),
      );
    }
    const jobMatch = /^\/activity\/([^/]+)$/.exec(url.pathname);
    if (jobMatch && request.method === "GET") {
      const job = getJob(jobMatch[1]);
      if (!job) return new Response("not found", { status: 404 });
      return renderJob(username, job, getLogsSince(job.id));
    }
    if (url.pathname === "/analytics" && request.method === "GET") {
      const range = url.searchParams.get("range") ?? "30d";
      return renderAnalytics(username, range, statsForRange(range));
    }
    if (url.pathname === "/settings" && request.method === "GET") {
      const config = readConfig();
      return renderSettings(
        username,
        config,
        config.webhookUrl || deps.webhookUrl || "",
        requestBaseUrl(request, url, Boolean(deps.trustProxy)),
      );
    }

    const match = matchRepo(url.pathname);
    if (match && request.method === "GET") {
      const fullName = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
      const row = requireRepo(fullName);
      const sub = match[3];
      const pr = match[4] ? Number(match[4]) : undefined;
      if (!sub) {
        const config = readConfig();
        return renderRepo(
          username,
          repoOverview(fullName),
          config.webhookUrl || deps.webhookUrl || "",
        );
      }
      if (sub === "pulls" && pr) {
        return renderPr(username, fullName, prDetail(fullName, pr));
      }
      if (sub === "pulls") {
        const page = Number(url.searchParams.get("page") ?? 1);
        return renderRepoPulls(
          username,
          fullName,
          repoPulls(fullName, page, 20),
          await openPullsFor(fullName, deps.githubApp),
        );
      }
      if (sub === "remote") {
        return renderRepoRemote(
          username,
          fullName,
          repoRemoteReviews(fullName),
        );
      }
      if (sub === "knowledge") {
        return renderKnowledge(
          username,
          await repoKnowledge(fullName),
          url.searchParams.get("view") ?? undefined,
        );
      }
      if (sub === "settings") {
        const config = readConfig();
        return renderRepoSettings(
          username,
          row,
          config.repos?.[fullName] ?? {},
        );
      }
    }
  } catch (error) {
    if (error instanceof RepoNotFound) {
      return new Response("not found", { status: 404 });
    }
    throw error;
  }
  return undefined;
}

function toHomeRow(item: ReturnType<typeof listReposForHome>[number]) {
  const job = item.latestJob;
  let statusKind: "ok" | "warn" | "err" | "run" = "ok";
  let status = "Active";
  if (job && (job.status === "running" || job.status === "queued")) {
    statusKind = "run";
    status = "Setting up";
  } else if (job?.status === "failed" && !item.repo.knowledge_built_at) {
    statusKind = "err";
    status = "Setup failed";
  }
  let knowledge = "Not built";
  let knowledgeAt: string | undefined;
  if (item.repo.knowledge_built_at) {
    knowledge =
      (item.drift?.prs_since ?? 0) > 0 ? "Needs update" : "Up to date";
    knowledgeAt = item.repo.knowledge_built_at;
  }
  return {
    fullName: item.repo.full_name,
    statusKind,
    status,
    knowledge,
    knowledgeAt,
    autoOn: item.repo.auto_review === 1,
    reviews: String(item.stats.reviews),
    cost: money(item.stats.cost),
  };
}

function requireRepo(fullName: string) {
  const row = getRepo(fullName);
  if (!row || row.active !== 1) throw new RepoNotFound(fullName);
  return row;
}

async function repoPicker(githubApp: PageDeps["githubApp"]): Promise<{
  repos: { fullName: string; account: string; alreadyActive: boolean }[];
  error?: string;
}> {
  if (!githubApp) {
    return {
      repos: [],
      error: "Configure the GitHub App in Settings first.",
    };
  }
  try {
    const installations = await listInstallationsWithRepos(
      githubApp.appId,
      githubApp.privateKeyPem,
    );
    return {
      repos: installations.flatMap(({ installation, repos }) =>
        repos
          .filter((repo) => repo.fullName)
          .map((repo) => ({
            fullName: repo.fullName,
            account: installation.account?.login ?? "unknown",
            alreadyActive: Boolean(getRepo(repo.fullName)?.active),
          })),
      ),
    };
  } catch (error) {
    console.error(
      "[dashboard] Could not list repositories from GitHub:",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return {
      repos: [],
      error: "Could not list repositories from GitHub.",
    };
  }
}

function isPagePath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/setup" ||
    pathname === "/activity" ||
    pathname.startsWith("/activity/") ||
    pathname === "/analytics" ||
    pathname === "/settings" ||
    pathname === "/repos/new" ||
    pathname.startsWith("/repos/")
  );
}

/** Open pull requests for the Pull requests tab, or `undefined` when the App
 * is not configured or cannot see the repo. A GitHub failure degrades to
 * `undefined` (the tab still works by number) rather than blanking the page. */
async function openPullsFor(
  fullName: string,
  githubApp: PageDeps["githubApp"],
): Promise<{ pulls: OpenPull[] | undefined; appConfigured: boolean }> {
  if (!githubApp) return { pulls: undefined, appConfigured: false };
  try {
    const pulls = await listOpenPulls(
      githubApp.appId,
      githubApp.privateKeyPem,
      fullName,
    );
    return { pulls, appConfigured: true };
  } catch (error) {
    console.error(
      "[dashboard] Could not list open pull requests:",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return { pulls: undefined, appConfigured: true };
  }
}

async function sessionOf(request: Request) {
  const token = readSessionToken(request);
  if (!token) return undefined;
  return await verifySession(token);
}

function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

/** The externally visible origin. Behind a trusted proxy the browser reached
 * `x-forwarded-host`/`-proto`, which is what GitHub must be told for the
 * callback and webhook URLs. Without the flag, `new URL(request.url).origin`
 * is the socket's own view and a spoofed header is ignored. */
function requestBaseUrl(
  request: Request,
  url: URL,
  trustProxy: boolean,
): string {
  if (!trustProxy) return url.origin;
  const last = (name: string) =>
    request.headers.get(name)?.split(",").pop()?.trim();
  const host = last("x-forwarded-host");
  if (!host) return url.origin;
  const proto = last("x-forwarded-proto");
  const scheme =
    proto === "https" || proto === "http"
      ? proto
      : url.protocol.replace(":", "");
  return `${scheme}://${host}`;
}

/** Step one of the App manifest flow: build the manifest from the posted
 * name and auto-submit it to GitHub. The `state` is kept server-side (ten
 * minutes, single use) so a forged callback cannot write credentials. */
async function beginAppManifest(
  request: Request,
  url: URL,
  deps: PageDeps,
): Promise<Response> {
  let name = "";
  try {
    const form = await request.formData();
    name = String(form.get("name") ?? "");
  } catch {
    return new Response("Expected a form post.", { status: 400 });
  }
  const problem = appNameProblem(name);
  if (problem) return new Response(problem, { status: 422 });
  const config = readConfig();
  const baseUrl = requestBaseUrl(request, url, Boolean(deps.trustProxy));
  const webhookUrl = config.webhookUrl || deps.webhookUrl || "";
  const manifest = buildAppManifest({ name, baseUrl, webhookUrl });
  const state = beginManifestState();
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Creating the GitHub App · co-maintainer</title></head>
<body>
<form id="manifest" action="https://github.com/settings/apps/new?state=${escapeHtml(
    state,
  )}" method="post">
<input type="hidden" name="manifest" value="${escapeHtml(
    JSON.stringify(manifest).replace(/</g, "\\u003c"),
  )}">
<noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<p>Taking you to GitHub to create the App.</p>
<script>document.getElementById("manifest").submit();</script>
</body></html>`);
}

/** Step three, after GitHub redirects back with a one-time `code`. The code
 * is converted into real credentials and written to the config keys the
 * manual fields already use, then the browser is sent to the install page. */
async function finishAppManifest(
  request: Request,
  url: URL,
): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  if (!consumeManifestState(state)) {
    return new Response(
      "This App creation link is no longer valid. Start again from Settings.",
      { status: 400 },
    );
  }
  const code = url.searchParams.get("code") ?? "";
  if (!code) {
    return new Response("GitHub did not return a manifest code.", {
      status: 400,
    });
  }
  const config = readConfig();
  let conversion: Awaited<ReturnType<typeof convertManifest>>;
  try {
    conversion = await convertManifest(code);
  } catch (error) {
    console.error(
      "[dashboard] GitHub App manifest conversion failed:",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return new Response(
      "Could not create the GitHub App. Try again from Settings.",
      { status: 502 },
    );
  }
  const patch: Partial<UserConfig> = {
    githubAppId: conversion.appId,
    githubAppPrivateKey: conversion.pem,
  };
  if (conversion.webhookSecret) {
    patch.githubWebhookSecret = conversion.webhookSecret;
  }
  if (conversion.clientId && !config.githubOAuthClientId) {
    patch.githubOAuthClientId = conversion.clientId;
  }
  if (conversion.clientSecret && !config.githubOAuthClientSecret) {
    patch.githubOAuthClientSecret = conversion.clientSecret;
  }
  await writeUserConfig(patch);
  const installUrl = conversion.slug
    ? `https://github.com/apps/${encodeURIComponent(
        conversion.slug,
      )}/installations/new`
    : "https://github.com/settings/apps";
  return Response.redirect(installUrl, 303);
}

async function handleLoginForm(
  request: Request,
  deps: PageDeps,
  ip: string,
  auth: AuthMethods,
): Promise<Response> {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const next = safeNext(String(form.get("next") ?? "/"));
  if (!auth.password) {
    return renderLogin({
      next,
      error: "Password sign-in is disabled.",
      showPassword: auth.password,
      showGithub: auth.github,
      hint: deps.loginHint,
    });
  }
  const result = await login(password, deps.passwordStore, ip);
  if (!result) {
    return renderLogin({
      next,
      error: "Wrong password.",
      showPassword: auth.password,
      showGithub: auth.github,
      hint: deps.loginHint,
    });
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: next,
      "set-cookie": sessionCookieHeader(
        result.token,
        Boolean(deps.secureCookie),
      ),
    },
  });
}

/** `state` round-trips through an HttpOnly cookie set by `/auth/github`
 * (see `oauthStateCookieHeader`), not server memory — comparing it against
 * the query param is what stops a forged callback from creating a session. */
async function handleGithubCallback(
  request: Request,
  url: URL,
  githubOAuth: NonNullable<PageDeps["githubOAuth"]>,
  deps: PageDeps,
): Promise<Response> {
  const clearState = clearOauthStateCookieHeader(Boolean(deps.secureCookie));
  const fail = (message: string) =>
    new Response(null, {
      status: 303,
      headers: {
        location: `${url.origin}/login?error=${encodeURIComponent(message)}`,
        "set-cookie": clearState,
      },
    });
  const saved = readOauthState(request);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!saved || !code || !state || saved.state !== state) {
    return fail("GitHub sign-in failed.");
  }
  const login = await githubLoginFromCode({
    clientId: githubOAuth.clientId,
    clientSecret: githubOAuth.clientSecret,
    code,
    redirectUri: `${url.origin}/auth/github/callback`,
  });
  if (!login || login.toLowerCase() !== githubOAuth.allowedUser.toLowerCase()) {
    return fail("This GitHub account is not allowed to sign in.");
  }
  const result = await createSession();
  return new Response(null, {
    status: 303,
    headers: {
      location: saved.next,
      "set-cookie": sessionCookieHeader(
        result.token,
        Boolean(deps.secureCookie),
      ),
    },
  });
}
