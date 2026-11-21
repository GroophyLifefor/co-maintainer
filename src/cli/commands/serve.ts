import { registerSkipJobHandler } from "../../services/skip_commands.ts";
import {
  readConfig,
  resolveAppPrivateKey,
  appPrivateKeyFileMissing,
} from "../../config.ts";
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
import { setupChecklist } from "../../services/setup_checklist.ts";
import { discoverCliRepos } from "../../services/cli_repos.ts";
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
import { registerPushReviewHandlers } from "../../services/push_review.ts";
import { registerWatchCommentHandler } from "../../services/watch_comments.ts";
import { startRemoteWatchdog } from "../../remote/server/sessions.ts";
import { passwordProblem } from "../../util/password.ts";
import { deleteAllSessions } from "../../store/sessions.ts";
import { serveHttp } from "../../server/http.ts";
import { listJobs } from "../../store/jobs.ts";
import { removeServeRunFolders } from "../../extensions/run_folder.ts";
import { currentPlatform, getEnv, type Platform } from "../../util/runtime.ts";
import { webhookUrlProblem } from "../../server/webhook_url.ts";
import { die } from "../error.ts";
import type { AuthOverrides } from "../../server/live_auth.ts";

/** `undefined` on Linux, otherwise one line naming the platform. The
 * recommendation is spelled out rather than pointing at an internal
 * document, so the message stands on its own and links to the public
 * troubleshooting page for the details. */
export function platformWarning(os: Platform): string | undefined {
  if (os === "linux") return undefined;
  return `running on ${os}. Linux (WSL included) is the recommended platform for serve. See https://co-maintainer.com/docs/troubleshooting.html`;
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

/** What `--disable-auth=` and `--enable-auth=` force. Each takes `password`
 * or `github`, and a method named by both is refused. */
export function authOverridesFrom(args: string[]): AuthOverrides {
  const value = (flag: string) =>
    args.find((arg) => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3);
  const overrides: AuthOverrides = {};
  for (const [flag, on] of [
    ["disable-auth", false],
    ["enable-auth", true],
  ] as const) {
    const method = value(flag);
    if (method === undefined) continue;
    if (method !== "password" && method !== "github") {
      die(`--${flag} must be password or github`);
    }
    if (overrides[method] !== undefined) {
      die(`--disable-auth and --enable-auth cannot name the same method`);
    }
    overrides[method] = on;
  }
  return overrides;
}

/** The `serve` flags always win over the config defaults `co-maintainer set`
 * persisted. Dies if the result would leave no sign-in method active. Pure so
 * it is testable without a server. */
export function resolveAuthMethods(
  args: string[],
  config: Pick<UserConfig, "passwordAuthDisabled" | "githubAuthEnabled">,
): AuthMethods {
  const overrides = authOverridesFrom(args);
  const password = overrides.password ?? !config.passwordAuthDisabled;
  const github = overrides.github ?? Boolean(config.githubAuthEnabled);
  if (!password && !github) {
    die(
      "at least one sign-in method is required. Drop --disable-auth=password or pass --enable-auth=github",
    );
  }
  return { password, github };
}

export function resolveWebhookUrl(
  args: string[],
  port: number,
  configured?: string,
): string {
  const raw =
    webhookUrlOverride(args)?.value ??
    configured ??
    `http://localhost:${port}/github/webhook`;
  const problem = webhookUrlProblem(raw);
  // The same wording as before, named after the flag a user can fix.
  if (problem) die(problem.replace(/^webhook URL/, "--webhook-url"));
  return new URL(raw.trim()).toString();
}

/** The flag, then `CM_WEBHOOK_URL`. Both are fixed for the process, so the
 * dashboard shows the field locked while one of them is set. */
export function webhookUrlOverride(
  args: string[],
): { value: string; name: string } | undefined {
  const flag = args.find((arg) => arg.startsWith("--webhook-url="));
  if (flag)
    return {
      value: flag.slice("--webhook-url=".length),
      name: "--webhook-url",
    };
  const env = getEnv("CM_WEBHOOK_URL");
  return env ? { value: env, name: "CM_WEBHOOK_URL" } : undefined;
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
  const override = webhookUrlOverride(args);
  if (!config.githubAppId || !resolveAppPrivateKey(config)) {
    console.log(
      "[serve] GitHub App is not configured yet. Add it in the dashboard settings or with co-maintainer set.",
    );
  }
  if (appPrivateKeyFileMissing(config)) {
    console.log(
      `[serve] warning: the GitHub App private key file listed in config.json cannot be read (${config.githubAppPrivateKeyPath}). The App will not work until it is restored or replaced.`,
    );
  }

  const auth = resolveAuthMethods(args, config);
  let githubOAuth:
    { clientId: string; clientSecret: string; allowedUser: string } | undefined;
  if (auth.github) {
    if (
      !config.githubOAuthClientId ||
      !config.githubOAuthClientSecret ||
      !config.githubOAuthAllowedUser
    ) {
      die(
        "GitHub sign-in requires OAuth credentials. Run:\n" +
          "  co-maintainer set --github-oauth-client-id=... --github-oauth-client-secret=... --github-oauth-allowed-user=...",
      );
    }
    githubOAuth = {
      clientId: config.githubOAuthClientId,
      clientSecret: config.githubOAuthClientSecret,
      allowedUser: config.githubOAuthAllowedUser,
    };
  }

  // Before anything writes config.json: an upgrade's migration backs up the
  // config as it was, and `rollback` must get that copy back, not one this
  // version already rewrote.
  await openAppDb();
  console.log(`[serve] app.db ready at ${appDbPath()}`);

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

  if (args.some((arg) => arg.startsWith("--password="))) {
    // A password reset on the command line revokes every existing session, so a
    // leaked cookie cannot outlive it.
    deleteAllSessions();
  }
  const fromCli = await discoverCliRepos();
  if (fromCli.length > 0) {
    console.log(
      `[serve] added ${fromCli.length} repositor${fromCli.length === 1 ? "y" : "ies"} built from the CLI: ${fromCli.join(", ")}`,
    );
  }
  registerSetupJobHandler();
  registerReviewJobHandler();
  registerRemoteReviewHandler();
  registerReplyJobHandler();
  registerPushReviewHandlers();
  registerWatchCommentHandler();
  registerSkipJobHandler();
  // Before the orphans run again: a job still marked running keeps its
  // extension folder, which tells its rerun what the restart cut off.
  await removeServeRunFolders(
    new Set(listJobs({ status: "running" }).map((job) => job.id)),
  );
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

  const debug = args.includes("--debug") || getEnv("CM_DEBUG") === "1";
  if (debug) {
    console.log(
      "[serve] --debug is on. The /__ui component gallery is available.",
    );
  }

  const app = createApp({
    password: "",
    passwordStore,
    webhookUrl: `http://localhost:${port}/github/webhook`,
    ...(override
      ? {
          webhookUrlOverride: webhookUrl,
          webhookUrlOverrideName: override.name,
        }
      : {}),
    inject500,
    port,
    trustProxy,
    auth,
    githubOAuth,
    authOverrides: authOverridesFrom(args),
    debug,
    loginHint: getEnv("CM_LOGIN_HINT"),
  });
  const server = serveHttp(
    (req, remoteAddr) => app.fetch(req, remoteAddr),
    port,
  );
  // Nothing runs in the background and nothing claims to listen until the
  // port is really bound, so a busy port leaves no worker behind.
  try {
    await server.ready;
  } catch (error) {
    await closeAppDb();
    const code = (error as NodeJS.ErrnoException).code;
    die(
      code === "EADDRINUSE"
        ? `port ${port} is already in use. Stop the other server or pick another --port.`
        : `could not listen on port ${port}: ${(error as Error).message}`,
    );
  }
  startRemoteWatchdog();
  startWorkerLoop();
  startRemakeScheduler();
  console.log(`[serve] listening on http://localhost:${port}`);
  console.log(`[serve] dashboard at http://localhost:${port}/`);
  const steps = setupChecklist(webhookUrl);
  if (steps.some((step) => !step.done)) {
    console.log(
      `[serve] finish setup at http://localhost:${port}/setup (${steps.filter((s) => s.done).length}/${steps.length} done)`,
    );
  }
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
  // where it forcibly terminates the process before any handler can run.
  // Registering it anyway costs nothing and is correct wherever it does work.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  await server.finished;
}
