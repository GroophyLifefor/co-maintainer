import { readConfig } from "../../config.ts";
import type { UserConfig } from "../../config.ts";
import { appDbPath, closeAppDb, openAppDb } from "../../store/app_db.ts";
import { createApp } from "../../server/app.ts";
import { configPasswordStore } from "../../server/auth.ts";
import type { AuthMethods, PasswordStore } from "../../server/auth.ts";
import {
  recoverOrphans,
  startWorkerLoop,
  stopWorkerLoop,
} from "../../services/jobs.ts";
import { registerSetupJobHandler } from "../../services/setup.ts";
import { registerReviewJobHandler } from "../../services/review.ts";
import {
  recoverReplyRequests,
  registerReplyJobHandler,
} from "../../services/replies.ts";
import {
  startRemakeScheduler,
  stopRemakeScheduler,
} from "../../services/remake_cron.ts";
import { registerRemoteReviewHandler } from "../../services/remote_review.ts";
import { startRemoteWatchdog } from "../../remote/server/sessions.ts";
import { passwordProblem } from "../../util/password.ts";
import { serveHttp } from "../../server/http.ts";
import { currentPlatform, getEnv, type Platform } from "../../util/runtime.ts";
import { die } from "../error.ts";

/** `undefined` on Linux, otherwise one line naming the platform (a pure
 * function so it is testable without actually being off Linux). */
export function platformWarning(os: Platform): string | undefined {
  if (os === "linux") return undefined;
  return `running on ${os}. Linux (WSL included) is the recommended platform for serve — see PLAN.md Decision 5.`;
}

function generatePassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function resolveTrustProxy(
  args: string[],
  env: (name: string) => string | undefined = getEnv,
): boolean {
  return args.includes("--trust-proxy") || env("CM_TRUST_PROXY") === "1";
}

/** `--password=` replaces the stored password. With no flag the stored one is
 * kept, and a first start generates one, returned so the caller can print it. */
export async function ensureDashboardPassword(
  args: string[],
  hasStoredPassword: boolean,
  store: PasswordStore,
): Promise<string | undefined> {
  const flag = args
    .find((arg) => arg.startsWith("--password="))
    ?.slice("--password=".length);
  if (flag !== undefined) {
    const problem = passwordProblem(flag);
    if (problem) die(`--password: ${problem}`);
    await store.set(flag);
    return undefined;
  }
  if (hasStoredPassword) return undefined;
  const generated = generatePassword();
  await store.set(generated);
  return generated;
}

/** `--disable-auth=password` / `--enable-auth=github` always win over the
 * config defaults `co-maintainer set` persisted; dies if the result would
 * leave no sign-in method active. Pure so it is testable without a server. */
export function resolveAuthMethods(
  args: string[],
  config: Pick<UserConfig, "passwordAuthDisabled" | "githubAuthEnabled">,
): AuthMethods {
  const disableAuth = args
    .find((arg) => arg.startsWith("--disable-auth="))
    ?.slice("--disable-auth=".length);
  if (disableAuth && disableAuth !== "password") {
    die("--disable-auth only supports: password");
  }
  const enableAuth = args
    .find((arg) => arg.startsWith("--enable-auth="))
    ?.slice("--enable-auth=".length);
  if (enableAuth && enableAuth !== "github") {
    die("--enable-auth only supports: github");
  }
  const password = disableAuth ? false : !config.passwordAuthDisabled;
  const github = enableAuth ? true : Boolean(config.githubAuthEnabled);
  if (!password && !github) {
    die(
      "at least one sign-in method is required; drop --disable-auth=password or pass --enable-auth=github",
    );
  }
  return { password, github };
}

export function resolveWebhookUrl(
  args: string[],
  port: number,
  configured?: string,
): string {
  const flag = args.find((arg) => arg.startsWith("--webhook-url="));
  const raw =
    flag?.slice("--webhook-url=".length) ??
    getEnv("CM_WEBHOOK_URL") ??
    configured ??
    `http://localhost:${port}/github/webhook`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    die(
      "--webhook-url must be an absolute http(s) URL, e.g. " +
        "--webhook-url=https://example.com/github/webhook",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    die("--webhook-url must use http or https");
  }
  // `new URL` is lenient: "http://http://host/:5000/x" parses with host
  // "http" and the real URL buried in the path, and "http:///x" treats "x"
  // as the host. GitHub needs a routable host and a real webhook path, so
  // reject a leaked scheme, an empty authority, and a path that is just "/".
  // A single-label host (an internal Docker/k8s name) or an IPv6 literal is
  // legitimate, and both are indistinguishable from the "http:///x" spelling
  // once parsed, so the empty authority is caught on the raw string instead.
  const hasAuthority = /^https?:\/\/[^/?#]+/.test(raw.trim());
  if (
    !hasAuthority ||
    url.pathname.startsWith("//") ||
    url.pathname.includes("://") ||
    url.pathname === "/"
  ) {
    die(
      "--webhook-url must be an absolute http(s) URL with a webhook path, " +
        "e.g. --webhook-url=https://example.com/github/webhook",
    );
  }
  return url.toString();
}

/** `co-maintainer serve --port=N [--password=...] [--disable-auth=password]
 * [--enable-auth=github] [--inject-500]`. HMAC-verified `POST /github/webhook`
 * plus a dashboard gated by password and/or GitHub sign-in. The GitHub App
 * is optional at startup and can be added later from the dashboard settings
 * or `co-maintainer set`. GitHub sign-in needs
 * `--github-oauth-client-id`/`-client-secret`/`-allowed-user` set. */
export async function runServe(args: string[]): Promise<void> {
  const portArg = args
    .find((arg) => arg.startsWith("--port="))
    ?.slice("--port=".length);
  if (!portArg) die("--port is required, e.g. --port=5000");
  const port = Number(portArg);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    die("--port must be an integer between 1 and 65535");
  }

  const config = readConfig();
  const webhookUrl = resolveWebhookUrl(args, port, config.webhookUrl);
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    console.log(
      "[serve] GitHub App is not configured yet. Add it in the dashboard settings or with co-maintainer set.",
    );
  }

  const auth = resolveAuthMethods(args, config);
  let githubOAuth:
    | { clientId: string; clientSecret: string; allowedUser: string }
    | undefined;
  if (auth.github) {
    if (
      !config.githubOAuthClientId ||
      !config.githubOAuthClientSecret ||
      !config.githubOAuthAllowedUser
    ) {
      die(
        "GitHub sign-in requires OAuth credentials; run:\n" +
          "  co-maintainer set --github-oauth-client-id=... --github-oauth-client-secret=... --github-oauth-allowed-user=...",
      );
    }
    githubOAuth = {
      clientId: config.githubOAuthClientId,
      clientSecret: config.githubOAuthClientSecret,
      allowedUser: config.githubOAuthAllowedUser,
    };
  }

  const passwordStore = configPasswordStore();
  if (auth.password) {
    const generated = await ensureDashboardPassword(
      args,
      Boolean(config.dashboardPasswordHash),
      passwordStore,
    );
    console.log(
      generated
        ? `[serve] dashboard password: ${generated}`
        : "[serve] dashboard password is stored in config.json, change it in Settings",
    );
  }

  const warning = platformWarning(currentPlatform());
  if (warning) console.log(`[serve] warning: ${warning}`);

  await openAppDb();
  console.log(`[serve] app.db ready at ${appDbPath()}`);
  registerSetupJobHandler();
  registerReviewJobHandler();
  registerRemoteReviewHandler();
  startRemoteWatchdog();
  registerReplyJobHandler();
  const recovered = await recoverOrphans();
  if (recovered > 0) {
    console.log(
      `[serve] recovered ${recovered} orphaned job(s) from a previous run`,
    );
  }
  const recoveredReplies = recoverReplyRequests();
  if (recoveredReplies > 0) {
    console.log(
      `[serve] requeued ${recoveredReplies} unfinished conversation repl${
        recoveredReplies === 1 ? "y" : "ies"
      }`,
    );
  }
  startWorkerLoop();
  startRemakeScheduler();

  if (auth.github)
    console.log(
      `[serve] GitHub sign-in enabled for ${githubOAuth!.allowedUser}`,
    );

  const trustProxy = resolveTrustProxy(args);
  if (trustProxy) {
    console.log(
      "[serve] trusting x-forwarded-for and x-forwarded-proto from a reverse proxy",
    );
  }

  const inject500 =
    args.includes("--inject-500") || getEnv("CM_INJECT_500") === "1";
  if (inject500) {
    console.log(
      "[serve] --inject-500 is on. Mutating /api requests return 500.",
    );
  }

  const app = createApp({
    password: "",
    passwordStore,
    webhookUrl,
    inject500,
    trustProxy,
    auth,
    githubOAuth,
    loginHint: getEnv("CM_LOGIN_HINT"),
  });
  const server = serveHttp(
    (req, remoteAddr) => app.fetch(req, remoteAddr),
    port,
  );
  console.log(`[serve] listening on http://localhost:${port}`);
  console.log(`[serve] dashboard at http://localhost:${port}/`);
  console.log(`[serve] webhook URL: ${webhookUrl}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `[serve] received ${signal}, stopping new requests and closing app.db`,
    );
    stopRemakeScheduler();
    await stopWorkerLoop();
    await server.shutdown();
    await closeAppDb();
    console.log("[serve] shut down cleanly");
    process.exit(0);
  };
  // Ctrl+C in an interactive terminal fires this reliably everywhere,
  // including Windows. A SIGTERM sent by another process (a process
  // manager, `kill`, `taskkill`) is reliable on Linux but not on Windows,
  // where it forcibly terminates the process before any handler can run —
  // see the P3 Live note in PLAN.md. Registering it anyway costs nothing
  // and is correct wherever it does work.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  await server.finished;
}
