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
import type { AuthMethods } from "../auth.ts";
import { githubAuthorizeUrl, githubLoginFromCode } from "../../github/oauth.ts";
import { handleClient, handleLogo, handleStyles } from "../assets.ts";
import { readConfig } from "../../config.ts";
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
import { money } from "./layout.ts";
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
import { listInstallationsWithRepos } from "../../github/app.ts";

export type PageDeps = {
  password: string;
  webhookUrl?: string;
  secureCookie?: boolean;
  githubApp?: { appId: string; privateKeyPem: string };
  auth?: AuthMethods;
  githubOAuth?: { clientId: string; clientSecret: string; allowedUser: string };
};

const REPO =
  /^\/repos\/([^/]+)\/([^/]+)(?:\/(pulls|knowledge|settings)(?:\/(\d+))?)?$/;

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
      return renderHome(username, listReposForHome().map(toHomeRow));
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
      );
    }

    const match = REPO.exec(url.pathname);
    if (match && request.method === "GET") {
      const fullName = `${decodeURIComponent(match[1])}/${
        decodeURIComponent(match[2])
      }`;
      const row = requireRepo(fullName);
      const sub = match[3];
      const pr = match[4] ? Number(match[4]) : undefined;
      if (!sub) return renderRepo(username, repoOverview(fullName));
      if (sub === "pulls" && pr) {
        return renderPr(username, fullName, prDetail(fullName, pr));
      }
      if (sub === "pulls") {
        const page = Number(url.searchParams.get("page") ?? 1);
        return renderRepoPulls(
          username,
          fullName,
          repoPulls(fullName, page, 20),
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
    knowledge = (item.drift?.prs_since ?? 0) > 0
      ? "Needs update"
      : "Up to date";
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

async function repoPicker(
  githubApp: PageDeps["githubApp"],
): Promise<{
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
        repos.filter((repo) => repo.fullName).map((repo) => ({
          fullName: repo.fullName,
          account: installation.account?.login ?? "unknown",
          alreadyActive: Boolean(getRepo(repo.fullName)?.active),
        }))
      ),
    };
  } catch (error) {
    console.error(
      "[dashboard] Could not list repositories from GitHub:",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return {
      repos: [],
      error: "Could not list repositories from GitHub.",
    };
  }
}

function isPagePath(pathname: string): boolean {
  return pathname === "/" ||
    pathname === "/setup" ||
    pathname === "/activity" ||
    pathname.startsWith("/activity/") ||
    pathname === "/analytics" ||
    pathname === "/settings" ||
    pathname === "/repos/new" ||
    pathname.startsWith("/repos/");
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
    });
  }
  const result = await login(password, deps.password, ip);
  if (!result) {
    return renderLogin({
      next,
      error: "Wrong password.",
      showPassword: auth.password,
      showGithub: auth.github,
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
