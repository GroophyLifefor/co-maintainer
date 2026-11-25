/** `co-maintainer login-link`: a one-time dashboard sign-in link, made on
 * the server.
 *
 * Whoever can run this can already read `config.json`, so the link adds no
 * new way in. It works for 5 minutes, once, on one host, and a new link
 * replaces the old one. The token rides in the URL fragment, which a
 * browser never sends with a GET, so it stays out of proxy logs. Only the
 * URL goes to stdout, so a script can read it. */
import { CliError, EXIT_USAGE } from "../error.ts";
import { unknownOptionMessage } from "./registry.ts";
import { readConfig } from "../../config.ts";
import { getEnv } from "../../util/runtime.ts";
import { isAppDbOpen, liveLockPid, withAppDb } from "../../store/app_db.ts";
import { createLoginLink } from "../../server/auth.ts";
import { audit } from "../../services/audit.ts";

/** The dashboard's origin: `--origin`, then `CM_WEBHOOK_URL`, then the saved
 * webhook URL, the order `serve` resolves its own webhook URL in. */
function dashboardOrigin(flag: string | undefined): string | undefined {
  const raw =
    flag !== undefined
      ? flag
      : (getEnv("CM_WEBHOOK_URL") ?? readConfig().webhookUrl);
  if (!raw || !raw.trim()) return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export async function runLoginLink(args: string[]): Promise<void> {
  let originFlag: string | undefined;
  for (const arg of args) {
    if (arg.startsWith("--origin=")) originFlag = arg.slice("--origin=".length);
    else throw new CliError("usage", unknownOptionMessage(arg, "login-link"));
  }
  const origin = dashboardOrigin(originFlag);
  if (!origin) {
    throw new CliError(
      "usage",
      originFlag !== undefined
        ? `--origin must be an http or https address, got ${originFlag}`
        : "No dashboard address is known. serve's --webhook-url flag is not visible here.",
      "Pass the address you open the dashboard on, for example --origin=http://localhost:3000",
      EXIT_USAGE,
    );
  }
  if (!isAppDbOpen() && (await liveLockPid()) === undefined) {
    throw new CliError(
      "serve_not_running",
      "No co-maintainer serve is running on this data directory, so the link would lead nowhere.",
      "Start serve, then run login-link again.",
      EXIT_USAGE,
    );
  }
  const host = new URL(origin).host;
  const made = await withAppDb(async () => {
    const token = await createLoginLink(host);
    audit("sign-in", "Made a sign-in link", { actor: "cli", target: origin });
    return token;
  });
  if (!made.ok) {
    throw new CliError(
      "serve_version_mismatch",
      `Could not make a sign-in link: ${made.reason}.`,
      "Run login-link with the same co-maintainer version serve runs.",
      EXIT_USAGE,
    );
  }
  console.log(`${origin}/login/link#${made.value}`);
  console.error(
    "The link works once, for 5 minutes, on this address. A new link replaces it.",
  );
}
