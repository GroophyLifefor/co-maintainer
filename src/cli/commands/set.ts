import { readConfig, configPath, writeUserConfig } from "../../config.ts";
import { hashPassword, passwordProblem } from "../../util/password.ts";
import { readTextFile } from "../../util/runtime.ts";
import { verifyOpenRouter } from "../../ai/verify.ts";
import { die } from "../error.ts";
import { renderCommandHelp, renderGlobalHelp } from "./registry.ts";

function text(args: string[], name: string): string | undefined {
  return args
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

const secretFields = new Set([
  "token",
  "githubPat",
  "githubAppPrivateKey",
  "githubWebhookSecret",
  "githubOAuthClientSecret",
  "remoteToken",
  "dashboardPasswordHash",
]);

/** `co-maintainer set --token=... --ai=... --low-model=... --high-model=...
 * --auth=... --github-app-id=... --github-app-private-key=... (or
 * --github-app-private-key-file=path or --github-app-private-key-path=path)
 * --github-webhook-secret=...` —
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
    "review-blocking",
    "password",
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

  const ai = text(args, "ai");
  if (ai && !["none", "openrouter", "hetzner"].includes(ai)) {
    die("--ai must be one of: none, openrouter, hetzner");
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
    "review-blocking": "reviewBlocking",
    password: "dashboardPasswordHash",
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
  const disableAuth = text(args, "disable-auth");
  if (disableAuth) {
    if (disableAuth !== "password")
      die("--disable-auth only supports: password");
    patch.passwordAuthDisabled = true;
  }
  const enableAuth = text(args, "enable-auth");
  if (enableAuth) {
    if (enableAuth !== "github") die("--enable-auth only supports: github");
    patch.githubAuthEnabled = true;
  }
  const remoteHost = text(args, "remote-host");
  if (remoteHost) patch.remoteHost = remoteHost;
  const remoteToken = text(args, "remote-token");
  if (remoteToken) patch.remoteToken = remoteToken;
  const reviewBlocking = text(args, "review-blocking");
  if (reviewBlocking) {
    if (!["model", "severity"].includes(reviewBlocking)) {
      die("--review-blocking must be one of: model, severity");
    }
    patch.reviewBlocking = reviewBlocking;
  }
  const password = text(args, "password");
  if (password) {
    const problem = passwordProblem(password);
    if (problem) die(`--password: ${problem}`);
    patch.dashboardPasswordHash = await hashPassword(password);
  }

  if (Object.keys(patch).length === 0) {
    die(
      "Nothing to set; pass --token= (or --ai-key=), --ai=, --low-model=, --high-model=, --auth=, --github-pat=, " +
        "--github-app-id=, --github-app-private-key(-file|-path)=, --github-webhook-secret=, " +
        "--github-oauth-client-id=, --github-oauth-client-secret=, --github-oauth-allowed-user=, " +
        "--remote-host=, --remote-token=, --review-blocking=model|severity, " +
        "--password=, --disable-auth=password, --enable-auth=github, or --unset=name",
    );
  }

  // Verify the key and model before writing, so a typo fails here instead of
  // after a review has already fetched and cloned the pull request (CORE-22).
  // A field present in the patch wins, including when its value is `undefined`
  // — that is an unset, and there is nothing left to verify.
  const before = readConfig();
  const effective = (field: keyof typeof patch): unknown =>
    field in patch ? patch[field] : before[field as keyof typeof before];
  const effectiveAi = effective("ai");
  const effectiveToken = effective("token");
  const effectiveHighModel = effective("highModel");
  if (verify && effectiveAi === "openrouter" && effectiveToken) {
    const result = await verifyOpenRouter(
      String(effectiveToken),
      effectiveHighModel === undefined ? undefined : String(effectiveHighModel),
    );
    if (result.status === "rejected") throw result.error;
    if (result.status === "unreachable") {
      console.error(
        `[set] could not verify the key and model (${result.reason}); saved anyway.`,
      );
    }
  }

  await writeUserConfig(patch);
  const summary = Object.entries(patch).map(([key, value]) =>
    value === undefined
      ? `${key} (unset)`
      : `${key}=${secretFields.has(key) ? "•".repeat(8) : value}`,
  );
  console.log(`[set] updated: ${summary.join(", ")}`);
  console.log(`Saved to ${configPath()}`);
}
