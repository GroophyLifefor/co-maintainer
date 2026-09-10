import { readConfig } from "../config.ts";

function die(message: string): never {
  throw new Error(message);
}

/** `co-maintainer serve --port=N` — placeholder HTTP server. Requires the
 * GitHub App credentials to already be set via `co-maintainer set`
 * (webhook secret is optional; only the App ID and private key gate
 * startup). */
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

  const server = Deno.serve({ port }, async (req) => {
    const url = new URL(req.url);
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
  await server.finished;
}
