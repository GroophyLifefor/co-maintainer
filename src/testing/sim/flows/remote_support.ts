/** What a remote review flow needs that the simulate core does not have yet.
 *
 * `review --remote` runs a client and a server that, in the simulation, share
 * one process. These pieces keep the two apart and make the run fast without
 * changing what either side does:
 *
 * - a client checkout: a real clone of a simulated repository, as a developer
 *   or a CI job has it, with a change on top.
 * - a codegraph stand-in installed where the client looks for codegraph, so
 *   the server's model can call a tool over the bridge and the client really
 *   runs it in its checkout. Every run is logged.
 * - the remote wire: a layer on top of the caught fetch that tags each call
 *   with the side that made it (client or server), records which key every AI
 *   call carried (by name, never the value), and lowers the sync interval the
 *   server advertises, as seen by the client only.
 * - `serveWhile`: the server's worker loop, running jobs while the client
 *   polls, the way `serve` does with its interval.
 *
 * The core keeps the real answers in its trace: the wire changes the client's
 * copy of a handshake answer only, after the trace recorded it. */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { currentAiJob } from "../ai_watch.ts";
import { sleep } from "../faults.ts";
import type { CliRun, Sim } from "../flow.ts";
import { REMOTE_HOST } from "../fetch.ts";

export type Side = "client" | "server";

/** One call through the wire. */
export type WireCall = {
  step: string;
  /** Who made it: the client CLI, the server's worker, or the flow itself. */
  side: Side | "flow";
  kind: "remote" | "ai";
  method: string;
  path: string;
  status: number;
  /** AI calls: the name of the key the call carried, e.g. `server AI key`.
   * `unknown key` when it matched none the wire knows. Never the value. */
  key?: string;
  job?: string;
};

export type RemoteWire = {
  calls: WireCall[];
  /** What the client sees of the handshake. The server's own answer stays
   * in `sim.trace.remote`. */
  handshake: { intervalSeconds: number; maxBodyBytes?: number };
  /** Keys an AI call may carry, by name, beside the server's own. */
  keys: Map<string, string>;
  /** Runs before a client remote call reaches the server. */
  beforeRemote?: (call: {
    method: string;
    path: string;
    body: unknown;
    token: string;
  }) => Promise<void>;
  asClient<T>(fn: () => Promise<T>): Promise<T>;
  asServer<T>(fn: () => Promise<T>): Promise<T>;
};

const side = new AsyncLocalStorage<Side>();

/** The AI hosts the core's fetch answers. */
const AI_HOSTS = new Set([
  "openrouter.ai",
  "api.openai.com",
  "api.anthropic.com",
  "opencode.ai",
]);

function parse(body: unknown): unknown {
  if (typeof body !== "string") return body ?? null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** The wire for this flow, installed on first use. It sits on top of the
 * core's caught fetch, so `runFlow` removes it with that fetch at the end. */
export function remoteWire(sim: Sim): RemoteWire {
  const existing = sim.state.remoteWire as RemoteWire | undefined;
  if (existing) return existing;
  const wire: RemoteWire = {
    calls: [],
    // A real server says 3 seconds. A poll every 10 ms keeps the same loop,
    // only faster: the client sleeps between syncs as it would.
    handshake: { intervalSeconds: 0.01 },
    keys: new Map(),
    asClient: (fn) => side.run("client", fn),
    asServer: (fn) => side.run("server", fn),
  };
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const bearer =
      /^(?:Bearer|token)\s+(.+)$/i.exec(
        headers.get("authorization") ?? "",
      )?.[1] ?? "";
    const who = side.getStore() ?? "flow";
    const isAi = AI_HOSTS.has(url.hostname);
    if (url.hostname === REMOTE_HOST && wire.beforeRemote && who === "client") {
      await wire.beforeRemote({
        method,
        path: url.pathname,
        body: parse(init?.body),
        token: bearer,
      });
    }
    const job = isAi ? currentAiJob() : undefined;
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (error) {
      if (url.hostname === REMOTE_HOST || isAi) {
        wire.calls.push({
          step: sim.trace.step,
          side: who,
          kind: isAi ? "ai" : "remote",
          method,
          path: url.pathname,
          status: 0,
          ...(isAi ? { key: keyName(sim, wire, bearer), job } : {}),
        });
      }
      throw error;
    }
    if (url.hostname === REMOTE_HOST || isAi) {
      wire.calls.push({
        step: sim.trace.step,
        side: who,
        kind: isAi ? "ai" : "remote",
        method,
        path: url.pathname,
        status: response.status,
        ...(isAi ? { key: keyName(sim, wire, bearer), job } : {}),
      });
    }
    if (
      url.hostname === REMOTE_HOST &&
      url.pathname === "/api/remote/handshake" &&
      response.ok
    ) {
      const body = (await response.json()) as Record<string, unknown>;
      const sync = (body.sync ?? {}) as Record<string, unknown>;
      const limits = (body.limits ?? {}) as Record<string, unknown>;
      return Response.json(
        {
          ...body,
          sync: { ...sync, intervalSeconds: wire.handshake.intervalSeconds },
          limits: {
            ...limits,
            ...(wire.handshake.maxBodyBytes === undefined
              ? {}
              : { maxBodyBytes: wire.handshake.maxBodyBytes }),
          },
        },
        { status: response.status },
      );
    }
    return response;
  };
  sim.state.remoteWire = wire;
  return wire;
}

function keyName(sim: Sim, wire: RemoteWire, bearer: string): string {
  if (!bearer) return "no key";
  if (bearer === sim.world.secrets.aiKey) return "server AI key";
  for (const [name, value] of wire.keys) if (value === bearer) return name;
  return "unknown key";
}

/** Runs `client` as the client while the server's worker runs every queued
 * job, as `serve` does on its interval. Returns when the client is done and
 * the jobs it started have ended. A job still running `waitMs` after the
 * client finished fails the step: it waits for a client that is gone. */
export async function serveWhile<T>(
  sim: Sim,
  client: () => Promise<T>,
  waitMs = 5000,
): Promise<T> {
  const wire = remoteWire(sim);
  let done = false;
  const worker = wire.asServer(async () => {
    while (!done) {
      await sim.server.runJobs();
      await sleep(2);
    }
    await sim.server.runJobs();
  });
  try {
    return await wire.asClient(client);
  } finally {
    done = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `a server job was still running ${waitMs} ms after the client ended`,
            ),
          ),
        waitMs,
      );
    });
    try {
      await Promise.race([worker, late]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A clone of a simulated repository, the way a developer or a CI job has
 * it: `origin` is `https://github.com/<repo>`, which git maps to the
 * simulated GitHub. */
export type Checkout = {
  dir: string;
  repo: string;
  git(args: string[]): string;
  /** Writes files into the working tree. */
  write(files: Record<string, string>): void;
  /** Commits everything in the working tree and returns the new sha. */
  commit(message: string): string;
};

export function clientCheckout(sim: Sim, repo: string, name: string): Checkout {
  const dir = join(sim.world.root, "client", name);
  mkdirSync(dirname(dir), { recursive: true });
  const run = (args: string[], cwd: string) => {
    const result = spawnSync("git", args, { cwd });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    }
    return result.stdout.toString().trim();
  };
  run(["clone", "-q", `https://github.com/${repo}`, dir], sim.world.root);
  // The world maps `https://github.com/` to the sandbox for every git
  // command, `git remote get-url` included, so the client would read a file
  // URL and refuse it as no GitHub remote. An SSH remote is not mapped, and
  // the SSH stand-in serves it from the same sandbox repository.
  run(["remote", "set-url", "origin", `git@github.com:${repo}.git`], dir);
  run(["config", "core.sshCommand", sshStandIn(sim)], dir);
  return {
    dir,
    repo,
    git: (args) => run(args, dir),
    write(files) {
      for (const [path, content] of Object.entries(files)) {
        const target = join(dir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    },
    commit(message) {
      run(["add", "-A"], dir);
      run(["commit", "-q", "-m", message], dir);
      return run(["rev-parse", "HEAD"], dir);
    },
  };
}

/** An `ssh` for git that never opens a socket: it runs the upload or
 * receive pack git asked for on the simulated GitHub's repository. Returns
 * the command for `core.sshCommand`. */
function sshStandIn(sim: Sim): string {
  const path = join(sim.world.root, "ssh-stand-in.cjs");
  const github = join(sim.world.root, "github");
  writeFileSync(
    path,
    `const { spawnSync } = require("node:child_process");
const path = require("node:path");
const command = process.argv[process.argv.length - 1];
const match = /^(git-upload-pack|git-receive-pack) '?\\/?([^']+?)(?:\\.git)?'?$/.exec(command);
if (!match) { console.error("ssh stand-in: refused " + command); process.exit(128); }
const dir = path.join(${JSON.stringify(github)}, match[2]);
const result = spawnSync("git", [match[1].slice(4), dir], { stdio: "inherit" });
process.exit(result.status ?? 128);
`,
  );
  return `"${process.execPath}" "${path}"`;
}

/** Runs the CLI from inside `dir`, as a person in that checkout would. The
 * server code running meanwhile reads only absolute paths. */
export async function cliIn(
  sim: Sim,
  dir: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<CliRun> {
  const cwd = process.cwd();
  const saved = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  process.chdir(dir);
  Object.assign(process.env, env);
  try {
    return await sim.cli(args);
  } finally {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** One codegraph run, as the stand-in logged it. */
export type CodegraphRun = { argv: string[]; cwd: string; dir: string | null };

export type CodegraphStandIn = {
  /** Every run so far, `--version` and indexing included. */
  runs(): CodegraphRun[];
  /** Runs that answered a tool call: not `--version`, not indexing. */
  toolRuns(): CodegraphRun[];
};

const INDEX_COMMANDS = new Set([
  "--version",
  "init",
  "sync",
  "index",
  "unlock",
]);

/** Installs a codegraph stand-in where the product looks for the pinned
 * version (`<tools>/codegraph/<version>/node_modules/.bin/codegraph`). It
 * answers `--version`, makes the index directory on `init`, and answers
 * `query <name>` with every line of the checkout that names it, so a tool
 * result is real text from the client's files. */
export async function installCodegraphStandIn(
  sim: Sim,
): Promise<CodegraphStandIn> {
  const existing = sim.state.codegraph as CodegraphStandIn | undefined;
  if (existing) return existing;
  const { binaryPath, codegraphVersion } =
    await import("../../../tools/codegraph.ts");
  const version = codegraphVersion();
  const log = join(sim.world.root, "codegraph-runs.jsonl");
  writeFileSync(log, "");
  const unix = binaryPath(version).replace(/\.cmd$/, "");
  mkdirSync(dirname(unix), { recursive: true });
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: args, cwd: process.cwd(), dir: process.env.CODEGRAPH_DIR ?? null }) + "\\n");
if (args[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
if (["init", "sync", "index", "unlock"].includes(args[0])) {
  fs.mkdirSync(path.join(process.cwd(), process.env.CODEGRAPH_DIR || ".codegraph"), { recursive: true });
  process.exit(0);
}
if (args[0] === "query" && args[1]) {
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === ".git" || name.startsWith(".co-maintainer") || name === ".codegraph") continue;
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) { walk(file); continue; }
      fs.readFileSync(file, "utf8").split("\\n").forEach((line, index) => {
        if (line.includes(args[1])) hits.push(path.relative(process.cwd(), file).split(path.sep).join("/") + ":" + (index + 1) + "  " + line.trim());
      });
    }
  };
  walk(process.cwd());
  console.log(hits.length ? hits.join("\\n") : "no symbol named " + args[1]);
  process.exit(0);
}
console.error("codegraph stand-in: no answer for " + args.join(" "));
process.exit(1);
`;
  writeFileSync(unix, script);
  chmodSync(unix, 0o755);
  // Windows runs the `.cmd` shim, which hands the same script to node.
  writeFileSync(
    `${unix}.cmd`,
    `@"${process.execPath}" "%~dp0codegraph" %*\r\n`,
  );
  const runs = (): CodegraphRun[] =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CodegraphRun);
  const standIn: CodegraphStandIn = {
    runs,
    toolRuns: () =>
      runs().filter((run) => !INDEX_COMMANDS.has(run.argv[0] ?? "")),
  };
  sim.state.codegraph = standIn;
  return standIn;
}
