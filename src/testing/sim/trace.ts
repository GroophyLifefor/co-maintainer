/** Everything a simulated flow did, so the checks and the report can look at
 * every call instead of only the final files: GitHub, AI and remote calls as
 * they happen, each provider `complete()`, webhook deliveries, server jobs,
 * product log lines, and after the run the git commands, the files written
 * and the database rows. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type HttpCall = {
  /** The step that was running, e.g. `init` or `judge`. */
  step: string;
  /** When the call started, in ms since the run started. */
  startMs: number;
  method: string;
  url: string;
  status: number;
  ms: number;
  request: unknown;
  response: unknown;
};

export type GithubCall = HttpCall & {
  /** False when the simulated GitHub has no route for the call. */
  handled: boolean;
  /** `gh` when the product reached GitHub through the `gh` stand-in. */
  via: "fetch" | "gh";
  /** The fault the call met on purpose, e.g. `500`. */
  fault?: string;
};

export type AiCall = HttpCall & {
  mode: "fake" | "live";
  /** The job name the product gave the call. */
  job?: string;
  /** The fake AI rule that answered. */
  rule?: string;
  /** True when no fake AI rule matched the call. */
  unscripted?: boolean;
  fault?: string;
};

/** A call to the simulated remote server, answered by its real routes. */
export type RemoteCall = HttpCall & { fault?: string };

/** A webhook handed to the server's real handler. */
export type WebhookDelivery = {
  step: string;
  startMs: number;
  event: string;
  action?: string;
  deliveryId: string;
  status: number;
  response: unknown;
};

/** One `complete()` on a provider: what the product sent and got back,
 * however many HTTP calls it took. Checks and scores read these, so they do
 * not depend on any provider's wire format. */
export type Completion = {
  step: string;
  startMs: number;
  job: string;
  ok: boolean;
  /** The system prompt, every system message joined. */
  system: string;
  /** The first user message: one conversation keeps it across rounds. */
  firstUser: string;
  /** What the product got back. Zero when the call threw. */
  tokensIn: number;
  tokensOut: number;
  /** What the provider reported on the wire for this call, every HTTP answer
   * included: the spend, even for a call the product then threw on. */
  billedIn: number;
  billedOut: number;
  cost: number | null;
  /** Tools the model asked for in this answer. */
  toolCalls: number;
  /** Their ids. A later round answers them, which ties it to this one. */
  toolCallIds: string[];
  /** The tool call ids this request answers with results. */
  answers: string[];
  error?: string;
};

/** A request that carried a secret in a header. Only the secret's name is
 * kept. */
export type CredentialUse = {
  step: string;
  startMs: number;
  host: string;
  secret: string;
};

/** One `sim.cli()` run: what the CLI printed. Secrets in the arguments are
 * replaced by their names. */
export type CliOutput = {
  step: string;
  startMs: number;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** A server job the flow ran to its end. */
export type JobRun = {
  step: string;
  id: string;
  type: string;
  repo: string;
  status: string;
  error: string | null;
};

export type GitCommand = {
  argv: string[];
  code: number | null;
  startMs: number;
  ms: number;
};

export type FileEntry = { path: string; bytes: number; content: string };

export class Trace {
  step = "setup";
  readonly github: GithubCall[] = [];
  readonly ai: AiCall[] = [];
  readonly remote: RemoteCall[] = [];
  readonly webhooks: WebhookDelivery[] = [];
  readonly completions: Completion[] = [];
  readonly jobs: JobRun[] = [];
  readonly credentials: CredentialUse[] = [];
  readonly cli: CliOutput[] = [];
  /** Network calls the simulation refused: neither GitHub nor an allowed AI
   * host. */
  readonly leaks: {
    step: string;
    startMs: number;
    method: string;
    url: string;
  }[] = [];
  readonly logs: {
    step: string;
    startMs: number;
    phase: string;
    message: string;
  }[] = [];

  /** The run's start on the `performance.now()` clock. */
  private readonly origin: number;

  constructor(origin: number) {
    this.origin = origin;
  }

  /** Ms since the run started. */
  now(): number {
    return Math.round(performance.now() - this.origin);
  }

  log(phase: string, message: string): void {
    this.logs.push({ step: this.step, startMs: this.now(), phase, message });
  }
}

/** Top-level git processes from a trace2 event file, timed against the run
 * that started at `startedAt` (epoch ms). A nested sid (one with a `/`) is a
 * child git started by another git, such as `maintenance`, and is left out. */
export function readGitTrace(path: string, startedAt: number): GitCommand[] {
  if (!existsSync(path)) return [];
  const started = new Map<string, { argv: string[]; startMs: number }>();
  const commands: GitCommand[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line) as {
      event: string;
      sid: string;
      time?: string;
      argv?: string[];
      t_abs?: number;
      code?: number;
    };
    if (event.sid.includes("/")) continue;
    if (event.event === "start") {
      started.set(event.sid, {
        argv: event.argv ?? [],
        startMs: Math.round(Date.parse(event.time ?? "") - startedAt),
      });
    } else if (event.event === "exit") {
      const start = started.get(event.sid);
      if (!start) continue;
      commands.push({
        argv: start.argv,
        code: event.code ?? null,
        startMs: start.startMs,
        ms: Math.round((event.t_abs ?? 0) * 1000),
      });
    }
  }
  return commands;
}

/** Every file under `dir`, with its content. */
export function readFiles(dir: string): FileEntry[] {
  if (!existsSync(dir)) return [];
  const entries: FileEntry[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const content = readFileSync(path, "utf8");
        entries.push({
          path: relative(dir, path).replaceAll("\\", "/"),
          bytes: Buffer.byteLength(content),
          content,
        });
      }
    }
  };
  walk(dir);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Files in the sandbox that hold secrets on purpose, or are read another
 * way, and so are not searched as files: config.json is where the product
 * keeps its credentials, `github/` is the simulated GitHub's own copy of the
 * repositories, the databases are searched row by row, and git's object
 * store is compressed. */
export const NOT_SEARCHED = [
  "config.json",
  "github/",
  "*.db, *.db-wal, *.db-shm",
  ".git/objects/",
];

/** Every file in the sandbox a leak could land in. */
export function readSandbox(root: string): FileEntry[] {
  if (!existsSync(root)) return [];
  const entries: FileEntry[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const rel = relative(root, path).replaceAll("\\", "/");
      if (rel === "config.json" || rel === "github") continue;
      if (/\.db(-wal|-shm)?$/.test(rel) || /\.git\/objects$/.test(rel)) {
        continue;
      }
      if (statSync(path).isDirectory()) walk(path);
      else {
        const content = readFileSync(path, "utf8");
        entries.push({ path: rel, bytes: Buffer.byteLength(content), content });
      }
    }
  };
  walk(root);
  return entries;
}

/** Every row of every table, read-only. */
export function dumpDatabase(path: string): Record<string, unknown[]> {
  if (!existsSync(path)) return {};
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        database.prepare(`SELECT * FROM "${name}"`).all(),
      ]),
    );
  } finally {
    database.close();
  }
}
