import { readConfig } from "../config.ts";
import { handleDashboardRequest } from "./dashboard.ts";

function die(message: string): never {
  throw new Error(message);
}

function generatePassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isAuthorized(req: Request, password: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice("Basic ".length));
    const suppliedPassword = decoded.slice(decoded.indexOf(":") + 1);
    return suppliedPassword === password;
  } catch {
    return false;
  }
}

const unauthorized = () =>
  new Response("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="co-maintainer dashboard"' },
  });

/** `co-maintainer serve --port=N [--password=...]` — placeholder webhook
 * endpoint (logs every request, replies "hello") plus a password-gated
 * `/dashboard` for listing/init'ing repos and editing `set` config with
 * live init logs streamed over SSE. Requires the GitHub App to already be
 * configured via `co-maintainer set` (webhook secret is optional; only the
 * App ID and private key gate startup). */
export async function runServe(args: string[]): Promise<void> {
  const portArg = args.find((arg) => arg.startsWith("--port="))?.slice(
    "--port=".length,
  );
  if (!portArg) die("--port is required, e.g. --port=5000");
  const port = Number(portArg);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    die("--port must be an integer between 1 and 65535");
  }

  const config = readConfig();
  const missing = [
    !config.githubAppId && "--github-app-id=...",
    !config.githubAppPrivateKey &&
    "--github-app-private-key=... (or --github-app-private-key-file=path)",
  ].filter(Boolean);
  if (missing.length > 0) {
    die(
      `serve requires the GitHub App to be configured first; run:\n` +
        `  co-maintainer set ${missing.join(" ")}`,
    );
  }

  const password = args.find((arg) => arg.startsWith("--password="))?.slice(
    "--password=".length,
  ) ?? generatePassword();
  console.log(`[serve] dashboard password: ${password}`);

  const server = Deno.serve({ port }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/dashboard")) {
      if (!isAuthorized(req, password)) return unauthorized();
      return await handleDashboardRequest(req);
    }

    const headers = Object.fromEntries(req.headers);
    const bodyText = await req.text();
    let body: unknown = bodyText;
    try {
      if (bodyText) body = JSON.parse(bodyText);
    } catch {
      // not JSON, log the raw text as-is
    }
    console.log(
      `[serve] ${req.method} ${url.pathname}${url.search}\n` +
        `  headers: ${JSON.stringify(headers)}\n` +
        `  body: ${JSON.stringify(body)}`,
    );
    return new Response("hello");
  });
  console.log(`[serve] listening on http://localhost:${port}`);
  console.log(`[serve] dashboard at http://localhost:${port}/dashboard`);
  await server.finished;
}
