import { readConfig, writeUserConfig } from "../config.ts";

function die(message: string): never {
  throw new Error(message);
}

function text(args: string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(
    name.length + 3,
  );
}

/** `co-maintainer set --token=... --ai=... --low-model=... --high-model=...
 * --auth=...` — persists global defaults (including, deliberately, the API
 * token) to config.json so every other command can skip both the flag and
 * the interactive prompt. See docs/configuration.md for the tradeoff. */
export async function runSet(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(
      "Usage: co-maintainer set --token=... --ai=none|openrouter|hetzner --low-model=... --high-model=... --auth=gh|pat",
    );
    console.log(
      "Writes to the user config file; unset an entry with --unset=name (e.g. --unset=token).",
    );
    return;
  }
  const known = ["token", "ai", "low-model", "high-model", "auth", "unset"];
  for (const arg of args) {
    if (!arg.startsWith("--") || !known.some((name) => arg.startsWith(`--${name}=`))) {
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

  const unset = new Set(
    args.filter((arg) => arg.startsWith("--unset=")).map((arg) =>
      arg.slice("--unset=".length)
    ),
  );
  const fieldByFlag: Record<string, keyof typeof current> = {
    token: "token",
    ai: "ai",
    "low-model": "lowModel",
    "high-model": "highModel",
    auth: "auth",
  };
  const current = readConfig();
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

  if (Object.keys(patch).length === 0) {
    die(
      "Nothing to set; pass --token=, --ai=, --low-model=, --high-model=, --auth=, or --unset=name",
    );
  }

  await writeUserConfig(patch);
  const summary = Object.entries(patch).map(([key, value]) =>
    value === undefined
      ? `${key} (unset)`
      : `${key}=${key === "token" ? "•".repeat(8) : value}`
  );
  console.log(`[set] updated: ${summary.join(", ")}`);
}
