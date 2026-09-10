import { writeUserConfig } from "../config.ts";

function die(message: string): never {
  throw new Error(message);
}

function text(args: string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(
    name.length + 3,
  );
}

const secretFields = new Set([
  "token",
  "githubPat",
  "githubAppPrivateKey",
  "githubWebhookSecret",
]);

/** `co-maintainer set --token=... --ai=... --low-model=... --high-model=...
 * --auth=... --github-app-id=... --github-app-private-key=... (or
 * --github-app-private-key-file=path) --github-webhook-secret=...` —
 * persists global defaults, including secrets, to config.json so every
 * other command can skip both the flag and the interactive prompt. See
 * docs/configuration.md for the tradeoff. */
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
    "unset",
  ];
  for (const arg of args) {
    if (
      !arg.startsWith("--") || !known.some((name) => arg.startsWith(`--${name}=`))
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
  if (text(args, "github-app-private-key") && text(args, "github-app-private-key-file")) {
    die("Pass only one of --github-app-private-key or --github-app-private-key-file");
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
  };
  const unset = new Set(
    args.filter((arg) => arg.startsWith("--unset=")).map((arg) =>
      arg.slice("--unset=".length)
    ),
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
      patch.githubAppPrivateKey = await Deno.readTextFile(privateKeyFile);
    } catch (error) {
      die(`Could not read ${privateKeyFile}: ${String(error)}`);
    }
  }

  if (Object.keys(patch).length === 0) {
    die(
      "Nothing to set; pass --token=, --ai=, --low-model=, --high-model=, --auth=, --github-pat=, " +
        "--github-app-id=, --github-app-private-key(-file)=, --github-webhook-secret=, or --unset=name",
    );
  }

  await writeUserConfig(patch);
  const summary = Object.entries(patch).map(([key, value]) =>
    value === undefined
      ? `${key} (unset)`
      : `${key}=${secretFields.has(key) ? "•".repeat(8) : value}`
  );
  console.log(`[set] updated: ${summary.join(", ")}`);
}
