/** Failures a flow asks for on purpose.
 *
 * A flow adds a fault before the step that should meet it. The next call that
 * matches fails the way the fault says, then the fault is used up (or after
 * `times` calls). A fault that never fired is reported, so a flow cannot
 * believe it tested an error path it never reached. */

export type FaultKind =
  /** The resource is missing. */
  | "404"
  /** The service failed. */
  | "500"
  /** GitHub's primary limit at zero, resetting now, or the AI's 429. */
  | "rate-limit"
  /** No answer: the call fails as a connect timeout. */
  | "timeout"
  /** The real answer, `ms` late. */
  | "slow";

export type Fault = {
  target: "github" | "ai" | "remote";
  /** One of the named kinds, or any HTTP status, e.g. `422` or `403`. */
  kind: FaultKind | number;
  /** GitHub and remote: the HTTP method, e.g. `POST`. */
  method?: string;
  /** GitHub and remote: the endpoint, e.g. `/check-runs` or
   * `/pulls/1/reviews$`. A string matches anywhere in the path. */
  path?: string | RegExp;
  /** AI: the job name the product gave the call, e.g. `review_pull_request`. */
  job?: string | RegExp;
  /** AI: text in the prompt. */
  prompt?: string | RegExp;
  /** How many matching calls fail. Defaults to 1. */
  times?: number;
  /** `slow` only: the delay. Defaults to 50 ms. */
  ms?: number;
};

/** What a matching call looks like, as far as a fault can tell. */
export type FaultCall = {
  target: Fault["target"];
  method: string;
  path: string;
  job?: string;
  prompt?: string;
};

export type FiredFault = { fault: Fault; step: string; call: string };

function matches(pattern: string | RegExp | undefined, value?: string) {
  if (pattern === undefined) return true;
  if (value === undefined) return false;
  return typeof pattern === "string"
    ? value.includes(pattern)
    : pattern.test(value);
}

export class Faults {
  private readonly pending: { fault: Fault; left: number }[] = [];
  readonly fired: FiredFault[] = [];

  add(fault: Fault): void {
    this.pending.push({ fault, left: fault.times ?? 1 });
  }

  /** The fault this call meets, used up by one. */
  take(call: FaultCall, step: string): Fault | undefined {
    const entry = this.pending.find(
      ({ fault, left }) =>
        left > 0 &&
        fault.target === call.target &&
        (fault.method === undefined ||
          fault.method.toUpperCase() === call.method) &&
        matches(fault.path, call.path) &&
        matches(fault.job, call.job) &&
        matches(fault.prompt, call.prompt),
    );
    if (!entry) return undefined;
    entry.left--;
    this.fired.push({
      fault: entry.fault,
      step,
      call: `${call.method} ${call.path}${call.job ? ` (${call.job})` : ""}`,
    });
    return entry.fault;
  }

  /** Faults that still had calls left when the flow ended. */
  unused(): Fault[] {
    return this.pending
      .filter(({ left }) => left > 0)
      .map(({ fault }) => fault);
  }
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The error `fetch` rejects with when a connection times out. */
export function timeoutError(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    }),
  });
}

/** The plain HTTP status a fault answers with, or undefined for a rate
 * limit, a timeout or a slow answer. */
export function faultStatus(fault: Fault): number | undefined {
  if (typeof fault.kind === "number") return fault.kind;
  if (fault.kind === "404") return 404;
  if (fault.kind === "500") return 500;
  return undefined;
}

/** The message GitHub sends with a status. */
export function statusMessage(status: number): string {
  return (
    {
      400: "Bad Request",
      401: "Bad credentials",
      403: "Forbidden",
      404: "Not Found",
      409: "Conflict",
      422: "Unprocessable Entity",
      500: "Server Error",
      502: "Bad Gateway",
      503: "Service Unavailable",
    }[status] ?? `HTTP ${status}`
  );
}

/** One line naming a fault, for reports and check details. */
export function describeFault(fault: Fault): string {
  const where = [
    fault.method,
    fault.path === undefined ? undefined : String(fault.path),
    fault.job === undefined ? undefined : `job ${String(fault.job)}`,
    fault.prompt === undefined ? undefined : `prompt ${String(fault.prompt)}`,
  ]
    .filter(Boolean)
    .join(" ");
  return `${fault.target} ${fault.kind}${where ? ` on ${where}` : ""}`;
}
