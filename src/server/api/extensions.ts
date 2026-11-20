/** Extension management from the dashboard: list, register, update, enable,
 * disable and remove. Every write goes through the same `extension` command
 * the CLI runs, so both sides accept and refuse exactly the same values. */
import { errorResponse } from "../errors.ts";
import { CliError } from "../../cli/error.ts";
import { runExtensionCommand } from "../../extensions/command.ts";
import {
  DISABLED_MESSAGE,
  extensionsDisabled,
  formatTimeout,
  readRegistrations,
} from "../../extensions/registry.ts";
import { audit } from "../../services/audit.ts";

/** Body field to `extension` flag. */
const FIELDS: Record<string, string> = {
  command: "command",
  repos: "repos",
  reviewTypes: "review-types",
  runAfter: "run-after",
  parallelism: "parallelism",
  priority: "priority",
  failFast: "fail-fast",
  retryOnFailTimes: "retry-on-fail-times",
  maxRequestedRetries: "max-requested-retries",
  timeout: "timeout",
  rerunOnRestart: "rerun-on-restart",
};

function flagsFrom(body: Record<string, unknown>): string[] {
  const flags: string[] = [];
  for (const [field, flag] of Object.entries(FIELDS)) {
    const value = body[field];
    if (value === undefined || value === null || value === "") continue;
    flags.push(`--${flag}=${String(value)}`);
  }
  return flags;
}

async function run(args: string[]): Promise<Response | undefined> {
  // The command reports to the console. On the server that is the log, which
  // is the right place for it.
  try {
    await runExtensionCommand(args);
    return undefined;
  } catch (error) {
    if (error instanceof CliError) {
      return errorResponse(422, "invalid_extension", error.message);
    }
    throw error;
  }
}

export async function handleExtensionsRoute(
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (url.pathname === "/api/extensions" && request.method === "GET") {
    return Response.json({
      disabled: extensionsDisabled(),
      extensions: readRegistrations(undefined, () => {}).map((entry) => ({
        ...entry,
        timeout: formatTimeout(entry.timeoutSeconds),
      })),
    });
  }
  const match = /^\/api\/extensions(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return undefined;
  if (extensionsDisabled()) {
    return errorResponse(403, "extensions_disabled", DISABLED_MESSAGE);
  }
  const name = match[1] ? decodeURIComponent(match[1]) : undefined;
  let body: Record<string, unknown> = {};
  if (request.method === "POST" || request.method === "PATCH") {
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse(400, "bad_request", "expected a JSON body");
    }
  }
  if (!name && request.method === "POST") {
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return errorResponse(422, "invalid_extension", "name is required");
    }
    // The form names the run-after target on purpose, so an unknown one is
    // saved, as `--yes` does on the CLI.
    const failed = await run([
      "register",
      `--name=${body.name.trim()}`,
      ...flagsFrom(body),
      "--yes",
    ]);
    if (failed) return failed;
    audit("settings", "Registered an extension", { target: body.name.trim() });
    return Response.json({ ok: true });
  }
  if (name && request.method === "PATCH") {
    const steps: string[][] = [];
    const settings = flagsFrom(body);
    if (settings.length > 0) {
      steps.push(["update", `--name=${name}`, ...settings, "--yes"]);
    }
    if (typeof body.disabled === "boolean") {
      steps.push([body.disabled ? "disable" : "enable", `--name=${name}`]);
    }
    if (steps.length === 0) {
      return errorResponse(422, "invalid_extension", "nothing to change");
    }
    for (const step of steps) {
      const failed = await run(step);
      if (failed) return failed;
    }
    audit("settings", "Changed an extension", { target: name });
    return Response.json({ ok: true });
  }
  if (name && request.method === "DELETE") {
    const failed = await run(["remove", `--name=${name}`]);
    if (failed) return failed;
    audit("settings", "Removed an extension", { target: name });
    return Response.json({ ok: true });
  }
  return errorResponse(405, "method_not_allowed", "method not allowed");
}
