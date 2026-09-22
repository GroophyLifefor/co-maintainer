import {
  paginate,
  probeDelay,
  RATE_LIMIT_PROBE_MS,
  rateLimitError,
  waitForRateLimit,
} from "./client.ts";
import type { GitHubClient } from "../types.ts";
import { log } from "../util/log.ts";
import {
  commandOutput,
  commandWithInput,
  getEnv,
  type CommandOutput,
} from "../util/runtime.ts";

const PULSE_MS = 120_000;

/** Test seam: `CM_GH_BIN` replaces the `gh` command and `CM_GH_SCRIPT` (if
 * set) is prepended as its first argument, so a fake can be run as
 * `<bin> <script> api …` with no shell. Unset means the real `gh` on PATH, so
 * production behaviour is unchanged. Spawning without a shell matters: a shell
 * concatenates arguments unescaped, so an endpoint's `?`, `&` and `=` would be
 * reinterpreted by cmd.exe on Windows. */
function ghSpawn(): { command: string; prefix: string[] } {
  const bin = getEnv("CM_GH_BIN");
  if (!bin) return { command: "gh", prefix: [] };
  const script = getEnv("CM_GH_SCRIPT");
  return { command: bin, prefix: script ? [script] : [] };
}

type QuotaRow = { limit?: number; remaining?: number; reset?: number };
type QuotaBody = { resources?: { core?: QuotaRow; search?: QuotaRow } };
type Bucket = { remaining: number; resetAt: Date };

let lastCallAt = 0;
let pulse: ReturnType<typeof setInterval> | undefined;

function count(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "?";
}

function hhmm(reset: number | undefined): string {
  if (typeof reset !== "number" || !Number.isFinite(reset)) return "??:??";
  const date = new Date(reset * 1000);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** `core 4120/5000 · search 28/30 · reset 21:58` from a `rate_limit` body. */
export function quotaLine(body: QuotaBody): string {
  const core = body.resources?.core;
  const search = body.resources?.search;
  return `github quota · core ${count(core?.remaining)}/${count(core?.limit)} · search ${count(search?.remaining)}/${count(search?.limit)} · reset ${hhmm(core?.reset)}`;
}

async function printQuota(): Promise<void> {
  try {
    const { command, prefix } = ghSpawn();
    const result = await commandOutput(command, {
      args: [...prefix, "api", "rate_limit"],
      stdout: "piped",
      stderr: "piped",
    });
    if (!result.success) return;
    log(
      "debug",
      quotaLine(JSON.parse(new TextDecoder().decode(result.stdout))),
    );
  } catch {
    // The line is diagnostic. The request it follows still stands.
  }
}

function unref(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    timer.unref();
  }
}

/** While `gh` calls keep landing, print the quota every two minutes.
 * The probe itself does not count as a call, so a quiet process stops. */
function noteGhCall(debug: boolean): void {
  if (!debug) return;
  lastCallAt = Date.now();
  if (pulse) return;
  const timer = setInterval(() => {
    if (Date.now() - lastCallAt > PULSE_MS) {
      clearInterval(timer);
      pulse = undefined;
      return;
    }
    void printQuota();
  }, PULSE_MS);
  unref(timer);
  pulse = timer;
}

async function readLimit(endpoint: string): Promise<Bucket | undefined> {
  try {
    const { command, prefix } = ghSpawn();
    const result = await commandOutput(command, {
      args: [...prefix, "api", "rate_limit"],
      stdout: "piped",
      stderr: "piped",
    });
    if (!result.success) return undefined;
    const body = JSON.parse(
      new TextDecoder().decode(result.stdout),
    ) as QuotaBody;
    const row = endpoint.startsWith("search/")
      ? body.resources?.search
      : body.resources?.core;
    if (
      !row ||
      typeof row.remaining !== "number" ||
      typeof row.reset !== "number"
    ) {
      return undefined;
    }
    return { remaining: row.remaining, resetAt: new Date(row.reset * 1000) };
  } catch {
    return undefined;
  }
}

export class GhClient implements GitHubClient {
  private readonly debug: boolean;

  constructor(debug = false) {
    this.debug = debug;
  }

  request<T>(endpoint: string): Promise<T> {
    return this.call(endpoint, () => {
      const { command, prefix } = ghSpawn();
      return commandOutput(command, {
        args: [...prefix, "api", endpoint],
        stdout: "piped",
        stderr: "piped",
      });
    });
  }

  write<T>(endpoint: string, body: unknown): Promise<T> {
    return this.send(endpoint, "POST", body);
  }

  createCheckRun<T>(endpoint: string, body: unknown): Promise<T> {
    return this.write<T>(endpoint, body);
  }

  updateCheckRun<T>(endpoint: string, body: unknown): Promise<T> {
    return this.send(endpoint, "PATCH", body);
  }

  pages<T>(
    endpoint: string,
    limit?: number,
    progress?: (page: number, fetched: number) => void,
  ): Promise<T[]> {
    return paginate((e) => this.request<T[]>(e), endpoint, limit, progress);
  }

  private send<T>(
    endpoint: string,
    method: "POST" | "PATCH",
    body: unknown,
  ): Promise<T> {
    return this.call(endpoint, () => {
      const { command, prefix } = ghSpawn();
      return commandWithInput(
        command,
        {
          args: [...prefix, "api", "-X", method, endpoint, "--input", "-"],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        },
        JSON.stringify(body),
      );
    });
  }

  private async call<T>(
    endpoint: string,
    run: () => Promise<CommandOutput>,
  ): Promise<T> {
    noteGhCall(this.debug);
    const started = Date.now();
    let spun = false;
    for (;;) {
      const result = await run();
      if (result.success) {
        try {
          return JSON.parse(new TextDecoder().decode(result.stdout)) as T;
        } catch {
          throw new Error(`gh returned invalid JSON for ${endpoint}`);
        }
      }
      const error = new TextDecoder().decode(result.stderr).trim();
      const bucket = await readLimit(endpoint);
      const limited = bucket
        ? bucket.remaining === 0
        : /rate limit/i.test(error);
      if (!limited) throw new Error(`gh api failed: ${error || endpoint}`);
      const resetAt =
        bucket?.resetAt ?? new Date(Date.now() + RATE_LIMIT_PROBE_MS);
      const delay = probeDelay(resetAt, Date.now());
      if (delay === 0) {
        if (spun) throw rateLimitError(resetAt);
        spun = true;
        continue;
      }
      spun = false;
      await waitForRateLimit(resetAt, started);
    }
  }
}
