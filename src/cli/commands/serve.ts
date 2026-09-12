import { readConfig } from "../../config.ts";
import { ensureCodegraph } from "../../tools/codegraph.ts";
import { appDbPath, closeAppDb, openAppDb } from "../../store/app_db.ts";
import { createApp } from "../../server/app.ts";
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

/** `undefined` on Linux, otherwise one line naming the platform (a pure
 * function so it is testable without actually being off Linux). */
export function platformWarning(os: typeof Deno.build.os): string | undefined {
  if (os === "linux") return undefined;
  return `running on ${os}. Linux (WSL included) is the recommended platform for serve — see PLAN.md Decision 5.`;
}

function die(message: string): never {
  throw new Error(message);
}

function generatePassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function resolveWebhookUrl(
  args: string[],
  port: number,
  configured?: string,
): string {
  const flag = args.find((arg) => arg.startsWith("--webhook-url="));
  const raw = flag?.slice("--webhook-url=".length) ??
    Deno.env.get("CM_WEBHOOK_URL") ??
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
  return url.toString();
}

/** `co-maintainer serve --port=N [--password=...] [--inject-500]`. HMAC-verified
 * `POST /github/webhook` plus a password-gated dashboard. Requires the
 * GitHub App via `co-maintainer set` (webhook secret is optional, only the
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

  // The server indexes repositories on demand, so the tool has to be there
  // before it starts accepting webhooks rather than failing on the first job.
  await ensureCodegraph({
    allowInstall: args.includes("--allow-tool-install"),
  });

  const config = readConfig();
  const webhookUrl = resolveWebhookUrl(args, port, config.webhookUrl);
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

  const warning = platformWarning(Deno.build.os);
  if (warning) console.log(`[serve] warning: ${warning}`);

  await openAppDb();
  console.log(`[serve] app.db ready at ${appDbPath()}`);
  registerSetupJobHandler();
  registerReviewJobHandler();
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

  const password = args.find((arg) => arg.startsWith("--password="))?.slice(
    "--password=".length,
  ) ?? generatePassword();
  console.log(`[serve] dashboard password: ${password}`);

  const inject500 = args.includes("--inject-500") ||
    Deno.env.get("CM_INJECT_500") === "1";
  if (inject500) {
    console.log(
      "[serve] --inject-500 is on. Mutating /api requests return 500.",
    );
  }

  const app = createApp({
    password,
    githubApp: config.githubAppId && config.githubAppPrivateKey
      ? {
        appId: config.githubAppId,
        privateKeyPem: config.githubAppPrivateKey,
      }
      : undefined,
    webhookSecret: config.githubWebhookSecret,
    webhookUrl,
    inject500,
  });
  const server = Deno.serve({ port }, async (req, info) => {
    const remoteAddr = info.remoteAddr.transport === "tcp"
      ? info.remoteAddr.hostname
      : undefined;
    return await app.fetch(req, remoteAddr);
  });
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
    await stopWorkerLoop();
    await server.shutdown();
    await closeAppDb();
    console.log("[serve] shut down cleanly");
    Deno.exit(0);
  };
  // Ctrl+C in an interactive terminal fires this reliably everywhere,
  // including Windows. A SIGTERM sent by another process (a process
  // manager, `kill`, `taskkill`) is reliable on Linux but not on Windows,
  // where it forcibly terminates the process before any handler can run —
  // see the P3 Live note in PLAN.md. Registering it anyway costs nothing
  // and is correct wherever it does work.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(signal, () => void shutdown(signal));
    } catch {
      // Not supported on this platform — nothing to fall back to.
    }
  }

  await server.finished;
}
