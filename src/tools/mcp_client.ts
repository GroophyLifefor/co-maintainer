/** A hand-written MCP client over stdio (issue 79).
 *
 * It speaks newline-delimited JSON-RPC 2.0 and knows five messages:
 * `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, and
 * an answer to the server's `ping`. HTTP transports and OAuth would be the
 * only reason to add the SDK, and the project keeps no runtime dependency.
 *
 * The server process gets the `env` from its config plus `PATH` and `HOME`.
 * co-maintainer's own tokens are never passed. What the server prints on
 * stderr is kept only to say why a start failed, and is never sent anywhere
 * else. */
import type { ChildProcess } from "node:child_process";
import { commandPipe, getEnv } from "../util/runtime.ts";
import { VERSION } from "../version.ts";
import type { McpServerConfig } from "./mcp_config.ts";

/** The protocol version co-maintainer asks for. A server that answers with
 * another one is still used: the five messages are the same in each. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Startup, `initialize` and `tools/list` together. */
export const MCP_STARTUP_MS = 10_000;

/** A line longer than this is not a message anyone meant to send. */
const MAX_LINE_CHARS = 16 * 1024 * 1024;

/** The stderr tail kept for a failed start. */
const STDERR_TAIL_CHARS = 2000;

/** How long `stop` waits after closing stdin, then after SIGTERM. */
const STOP_GRACE_MS = 1000;

/** At most this many `tools/list` pages are read. */
const MAX_LIST_PAGES = 20;

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: unknown };
};

/** One `tools/call` answer: the text parts joined, and whether the server
 * marked it as an error. */
export type McpCallResult = { text: string; isError: boolean };

/** Why a server cannot be used. The message is co-maintainer's own and never
 * holds what the server sent. */
export class McpError extends Error {}

/** The server answered a request with a JSON-RPC error. It is still running,
 * so this is not `McpError`. */
export class McpRpcError extends Error {}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** The server's environment: its own `env`, plus `PATH` and `HOME`. */
export function mcpEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "HOME"]) {
    const value = getEnv(name);
    if (value !== undefined) out[name] = value;
  }
  return { ...out, ...env };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type Spawn = (
  command: string,
  options: { args: string[]; env: Record<string, string> },
) => ChildProcess;

export class McpClient {
  private readonly child: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private ended: McpError | undefined;
  private stderrTail = "";
  private readonly exited: Promise<void>;

  private constructor(child: ChildProcess) {
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("close", () => resolve());
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.read(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    // A server that exits while co-maintainer writes would otherwise throw
    // EPIPE out of the review.
    child.stdin?.on("error", () => {});
    child.on("error", (error) =>
      this.end(new McpError(`could not be run: ${error.message}`)),
    );
    child.on("close", (code, signal) =>
      this.end(
        new McpError(
          signal ? `exited on ${signal}` : `exited with code ${code ?? 1}`,
        ),
      ),
    );
  }

  /** Spawns the server, then `initialize`, `notifications/initialized` and
   * `tools/list`, all within `timeoutMs`. A server that fails any of them is
   * stopped before the error is thrown. */
  static async start(
    config: McpServerConfig,
    options: { timeoutMs?: number; spawn?: Spawn } = {},
  ): Promise<{ client: McpClient; tools: McpTool[] }> {
    const timeoutMs = options.timeoutMs ?? MCP_STARTUP_MS;
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    const spawn: Spawn =
      options.spawn ??
      ((command, spawnOptions) => commandPipe(command, spawnOptions));
    const client = new McpClient(
      spawn(config.command, {
        args: config.args ?? [],
        env: mcpEnv(config.env),
      }),
    );
    try {
      await client.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "co-maintainer", version: VERSION },
        },
        left(),
      );
      client.notify("notifications/initialized");
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = (await client.request(
          "tools/list",
          cursor ? { cursor } : {},
          left(),
        )) as { tools?: unknown; nextCursor?: unknown } | undefined;
        const listed: unknown[] = Array.isArray(result?.tools)
          ? result.tools
          : [];
        for (const tool of listed) {
          if (isRecord(tool) && typeof tool.name === "string") {
            tools.push(tool as McpTool);
          }
        }
        cursor =
          typeof result?.nextCursor === "string" && result.nextCursor
            ? result.nextCursor
            : undefined;
        if (!cursor) break;
      }
      return { client, tools };
    } catch (error) {
      await client.stop();
      throw error instanceof McpError
        ? error
        : new McpError(error instanceof Error ? error.message : String(error));
    }
  }

  /** What the server last printed on stderr, for a failed start's log line. */
  stderr(): string {
    return this.stderrTail.trim();
  }

  get alive(): boolean {
    return this.ended === undefined;
  }

  /** One `tools/call`. Text content is kept, anything else is left out with
   * a note. A timeout or an exit throws `McpError`. */
  async call(
    name: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<McpCallResult> {
    const result = (await this.request(
      "tools/call",
      {
        name,
        arguments:
          args && typeof args === "object" && !Array.isArray(args) ? args : {},
      },
      timeoutMs,
    )) as { content?: unknown; isError?: unknown } | undefined;
    const content: unknown[] = Array.isArray(result?.content)
      ? result.content
      : [];
    const texts: string[] = [];
    let other = 0;
    for (const item of content) {
      if (
        isRecord(item) &&
        item.type === "text" &&
        typeof item.text === "string"
      ) {
        texts.push(item.text);
      } else {
        other++;
      }
    }
    if (other > 0) {
      texts.push(
        `[${other} ${other === 1 ? "part that is" : "parts that are"} not text left out]`,
      );
    }
    return { text: texts.join("\n"), isError: result?.isError === true };
  }

  /** Closes stdin, which ends a well-behaved server, then SIGTERM, then
   * SIGKILL. Never throws. */
  async stop(): Promise<void> {
    const waitExit = (ms: number) =>
      Promise.race([
        this.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), ms);
          timer.unref?.();
        }),
      ]);
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.end(new McpError("stopped"));
      return;
    }
    try {
      this.child.stdin?.end();
    } catch {
      // already closed
    }
    if (!(await waitExit(STOP_GRACE_MS))) {
      this.child.kill("SIGTERM");
      if (!(await waitExit(STOP_GRACE_MS))) this.child.kill("SIGKILL");
    }
    this.end(new McpError("stopped"));
  }

  private end(error: McpError): void {
    if (!this.ended) this.ended = error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(this.ended);
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.ended) return;
    this.child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
    );
  }

  private notify(method: string): void {
    this.send({ method });
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.ended) return Promise.reject(this.ended);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpError(
            `did not answer ${method} within ${Number((timeoutMs / 1000).toFixed(1))} seconds`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.receive(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = "";
      this.end(new McpError("sent a line longer than 16 MB"));
      this.child.kill("SIGKILL");
    }
  }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      message = parsed as Record<string, unknown>;
    } catch {
      // A server that logs to stdout: the line is not a message.
      return;
    }
    if (typeof message.method === "string") {
      // A request from the server. Only ping is answered with a result.
      if (message.id === undefined || message.id === null) return;
      if (message.method === "ping") {
        this.send({ id: message.id, result: {} });
      } else {
        this.send({
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error && typeof message.error === "object") {
      const error = message.error as { code?: unknown };
      pending.reject(
        new McpRpcError(
          `answered with JSON-RPC error ${typeof error.code === "number" ? error.code : "?"}`,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }
}
