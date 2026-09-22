import { writeUserConfig } from "../../config.ts";
import { hashPassword, passwordProblem } from "../../util/password.ts";
import { readTextFile } from "../../util/runtime.ts";
import { die } from "../error.ts";

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
 * --github-app-private-key-file=path) --github-webhook-secret=...` —
 * persists global defaults, including secrets, to config.json so every
 * other command can skip both the flag and the interactive prompt. See
 * docs/md/configuration.md for the tradeoff. */
export async function runSet(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(
      "Usage: co-maintainer set --token=... --ai=none|openrouter|hetzner --low-model=... --high-model=... --auth=gh|pat --github-pat=...",
    );
    console.log(
      "                        --github-app-id=... --github-app-private-key=... | --github-app-private-key-file=path",
    );
    console.log("                        --github-webhook-secret=...");
    console.log(
      "                        --github-oauth-client-id=... --github-oauth-client-secret=... --github-oauth-allowed-user=...",
    );
    console.log(
      "                        --password=... --disable-auth=password --enable-auth=github",
    );
    console.log(
      "Writes to the user config file; unset an entry with --unset=name (e.g. --unset=token).",
    );
    return;
  }
  const known = [
    "token",
    "ai",
    "low-model",
    "high-model",
    "auth",
    "github-pat",
    "github-app-id",
    "github-app-private-key",
    "github-app-private-key-file",
    "github-webhook-secret",
    "github-oauth-client-id",
    "github-oauth-client-secret",
    "github-oauth-allowed-user",
    "disable-auth",
    "enable-auth",
    "remote-host",
    "remote-token",
    "password",
    "unset",
  ];
  for (const arg of args) {
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
  if (
    text(args, "github-app-private-key") &&
    text(args, "github-app-private-key-file")
  ) {
    die(
      "Pass only one of --github-app-private-key or --github-app-private-key-file",
    );
  }

  const fieldByFlag: Record<string, string> = {
    token: "token",
    ai: "ai",
    "low-model": "lowModel",
    "high-model": "highModel",
    auth: "auth",
    "github-pat": "githubPat",
    "github-app-id": "githubAppId",
    "github-app-private-key": "githubAppPrivateKey",
    "github-webhook-secret": "githubWebhookSecret",
    "github-oauth-client-id": "githubOAuthClientId",
    "github-oauth-client-secret": "githubOAuthClientSecret",
    "github-oauth-allowed-user": "githubOAuthAllowedUser",
    "disable-auth": "passwordAuthDisabled",
    "enable-auth": "githubAuthEnabled",
    "remote-host": "remoteHost",
    "remote-token": "remoteToken",
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
  const token = text(args, "token");
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
  const password = text(args, "password");
  if (password) {
    const problem = passwordProblem(password);
    if (problem) die(`--password: ${problem}`);
    patch.dashboardPasswordHash = await hashPassword(password);
  }

  if (Object.keys(patch).length === 0) {
    die(
      "Nothing to set; pass --token=, --ai=, --low-model=, --high-model=, --auth=, --github-pat=, " +
        "--github-app-id=, --github-app-private-key(-file)=, --github-webhook-secret=, " +
        "--github-oauth-client-id=, --github-oauth-client-secret=, --github-oauth-allowed-user=, " +
        "--password=, --disable-auth=password, --enable-auth=github, or --unset=name",
    );
  }

  await writeUserConfig(patch);
  const summary = Object.entries(patch).map(([key, value]) =>
    value === undefined
      ? `${key} (unset)`
      : `${key}=${secretFields.has(key) ? "•".repeat(8) : value}`,
  );
  console.log(`[set] updated: ${summary.join(", ")}`);
}
