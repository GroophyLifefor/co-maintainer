/** `co-maintainer oauth login|logout|refresh|ping|list-models --provider=...`
 *
 * The credential side of the experimental Sign in with ChatGPT support. Only
 * `login` starts a browser flow; the rest operate on an existing login and
 * fail clearly when there is none. See `docs/docs/providers.md`. */
import { die } from "../error.ts";
import {
  oauthOps,
  oauthUnknownProvider,
  resolveOAuthProvider,
} from "../../ai/oauth/registry.ts";
import { renderCommandHelp, renderGlobalHelp } from "./registry.ts";

const SUBCOMMANDS = [
  "login",
  "logout",
  "refresh",
  "ping",
  "list-models",
] as const;

function text(args: string[], name: string): string | undefined {
  return args
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

export async function runOAuth(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(renderCommandHelp("oauth") ?? renderGlobalHelp());
    return;
  }
  if (!SUBCOMMANDS.includes(sub as (typeof SUBCOMMANDS)[number])) {
    die(`oauth must be one of: ${SUBCOMMANDS.join(", ")}`);
  }
  for (const arg of args.slice(1)) {
    if (!arg.startsWith("--provider=")) {
      die(`Unknown option: ${arg}`);
    }
  }
  const provider = resolveOAuthProvider(text(args, "provider"));
  if (!provider) throw oauthUnknownProvider(text(args, "provider"));
  const ops = oauthOps(provider);

  const printModels = (
    models: { slug: string; displayName: string }[],
  ): void => {
    if (models.length === 0) {
      console.log("No models are available to this account.");
      return;
    }
    console.log("Available models:");
    for (const model of models) {
      console.log(`  ${model.slug} (${model.displayName})`);
    }
  };

  if (sub === "login") {
    const creds = await ops.login();
    console.log(
      `Signed in${creds.email ? ` as ${creds.email}` : ""}. Saved to ${ops.credentialsPath()}`,
    );
    return;
  }
  if (sub === "logout") {
    const removed = await ops.logout();
    console.log(
      removed
        ? "Signed out. The saved ChatGPT credentials were removed."
        : "Nothing to sign out.",
    );
    return;
  }
  if (sub === "refresh") {
    const creds = await ops.refresh();
    console.log(
      `Refreshed. New expiry: ${new Date(creds.expires_at).toISOString()}`,
    );
    return;
  }
  if (sub === "ping") {
    const { credentials, models } = await ops.ping();
    console.log(
      `Signed in${credentials.email ? ` as ${credentials.email}` : ""}.`,
    );
    printModels(models);
    return;
  }
  printModels(await ops.listModels());
}
