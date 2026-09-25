/** Shared HTTPS plumbing for the remote endpoints (CORE-25, CORE-44).
 *
 * `review --remote` and `view --remote` talk to the same server with the same
 * bearer token, so the base URL, the token header and the explanations for a
 * rejected token or an unreachable host live here rather than in the review
 * client alone. */
import { CliError, EXIT_USAGE, networkFailure } from "../cli/error.ts";

/** A usage error the CLI prints with its hint and exit code (CORE-12). */
export function die(
  code: string,
  message: string,
  hint?: string,
  exitCode = EXIT_USAGE,
): never {
  throw new CliError(code, message, hint, exitCode);
}

export function baseUrl(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    die(
      "remote_not_configured",
      "remoteHost must be an absolute http(s) URL.",
      "co-maintainer config set remote-host https://your-server",
    );
  }
  return trimmed;
}

export async function remoteFetch(
  host: string,
  token: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const url = `${baseUrl(host)}${path}`;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  try {
    const response = await fetch(url, { ...init, headers });
    // The server's 401 text is `invalid or missing token`, which does not say
    // where the token comes from or how to get another one (CORE-12).
    if (response.status === 401 || response.status === 403) {
      die(
        "remote_token_rejected",
        `The server at ${baseUrl(host)} rejected the remote review token.`,
        "Create one in its dashboard under Settings, Remote review tokens.",
        EXIT_USAGE,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw networkFailure(url, error);
  }
}

export async function readApiError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return String(body.error?.message ?? response.statusText);
  } catch {
    return response.statusText;
  }
}
