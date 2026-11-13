/** `gh` as `e2e:simulate` answers it.
 *
 * Local and CLI review read GitHub through the `gh` binary, a child process
 * the caught `fetch` never sees. The product's `setGhRunner` seam hands each
 * `gh api` call here instead, in this process, so it reaches the same
 * simulated GitHub as the PAT and App clients. The product still builds the
 * arguments, parses the output and maps the errors itself. */
import type { CommandOutput } from "../../util/runtime.ts";
import { describeFault, type Faults, sleep } from "./faults.ts";
import type { SimGithub } from "./github.ts";
import type { Trace } from "./trace.ts";

const encoder = new TextEncoder();

function output(code: number, stdout: string, stderr = ""): CommandOutput {
  return {
    success: code === 0,
    code,
    stdout: encoder.encode(stdout),
    stderr: encoder.encode(stderr),
  };
}

/** `gh api [-X METHOD] <endpoint> [--input -]` as method and endpoint. */
export function parseGhApi(
  args: string[],
): { method: string; endpoint: string } | undefined {
  if (args[0] !== "api") return undefined;
  let method = "GET";
  let endpoint: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-X" || arg === "--method") {
      method = (args[++index] ?? "GET").toUpperCase();
    } else if (arg === "--input") {
      index++;
    } else if (!arg.startsWith("-") && endpoint === undefined) {
      endpoint = arg;
    }
  }
  return endpoint === undefined ? undefined : { method, endpoint };
}

function parse(input: string | undefined): unknown {
  if (input === undefined) return null;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export function ghStandIn(options: {
  github: SimGithub;
  trace: Trace;
  faults: Faults;
}): (args: string[], input?: string) => Promise<CommandOutput> {
  const { github, trace, faults } = options;
  // After a rate-limit fault the product asks `gh api rate_limit` how long to
  // wait. It hears "none left, resetting now", so it retries at once.
  let limited = false;

  return async (args, input) => {
    const parsed = parseGhApi(args);
    const step = trace.step;
    const startMs = trace.now();
    const started = performance.now();
    const url = new URL(
      `https://api.github.com/${(parsed?.endpoint ?? args.join(" ")).replace(/^\/+/, "")}`,
    );
    const method = parsed?.method ?? "GET";
    const body = parse(input);
    const record = (
      status: number,
      response: unknown,
      handled: boolean,
      fault?: string,
    ) =>
      trace.github.push({
        step,
        startMs,
        method,
        url: url.toString(),
        status,
        ms: Math.round(performance.now() - started),
        request: body,
        response,
        handled,
        via: "gh",
        ...(fault ? { fault } : {}),
      });

    if (!parsed) {
      const message = `e2e:simulate does not simulate gh ${args.join(" ")}`;
      record(404, { message }, false);
      return output(1, "", message);
    }
    if (parsed.endpoint === "rate_limit" && limited) {
      limited = false;
      const row = {
        limit: 5000,
        remaining: 0,
        reset: Math.floor(Date.now() / 1000),
      };
      const answer = { resources: { core: row, search: row } };
      record(200, answer, true);
      return output(0, JSON.stringify(answer));
    }

    const fault = faults.take(
      { target: "github", method, path: url.pathname },
      step,
    );
    if (fault?.kind === "slow") await sleep(fault.ms ?? 50);
    else if (fault) {
      const label = describeFault(fault);
      if (fault.kind === "timeout") {
        const message = `Get "${url}": dial tcp: i/o timeout`;
        record(0, { message }, true, fault.kind);
        return output(1, "", message);
      }
      if (fault.kind === "rate-limit") limited = true;
      const status =
        fault.kind === "404" ? 404 : fault.kind === "500" ? 500 : 403;
      const message =
        fault.kind === "rate-limit"
          ? "API rate limit exceeded"
          : fault.kind === "404"
            ? "Not Found"
            : "Server Error";
      record(status, { message, fault: label }, true, fault.kind);
      return output(1, "", `gh: ${message} (HTTP ${status})`);
    }

    const route = github.route({
      method,
      url,
      body,
      via: "gh",
      step,
    });
    const status = route?.status ?? 404;
    const response = route?.body ?? {
      message: `Not Found (e2e:simulate has no route for ${method} ${url.pathname})`,
    };
    record(status, response, route !== undefined);
    if (status >= 200 && status < 300) {
      return output(0, JSON.stringify(response));
    }
    const message = String(
      (response as { message?: unknown }).message ?? "error",
    );
    return output(1, "", `gh: ${message} (HTTP ${status})`);
  };
}
