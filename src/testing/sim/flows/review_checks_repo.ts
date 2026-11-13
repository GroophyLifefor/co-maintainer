/** The repository and the changes of the `review-checks` flow.
 *
 * Issue 80 proposes seven review checks, each a question a careful reviewer
 * asks of any change. This file holds one small TypeScript service, `tally`,
 * and for each check a seeded change with one defect of that check's shape
 * plus its fixed twin, and three plain clean changes.
 *
 * Each seeded defect is modelled on the miss its check comes from (issues 60
 * to 66), cut down to the smallest code that keeps the shape. The changed
 * lines alone do not show it: the evidence sits in an unchanged file (the
 * reader, the generator, the rule a declaration follows) or, for the stale
 * statement, in an unchanged line of a file the change touches. A twin is the
 * same change done right, so it differs from its seeded change only where the
 * defect is, and any finding on it is noise.
 *
 * Kept as strings, like `sample_repo.ts`: as files on disk they would be
 * type-checked, linted and tested as if they were this project's own. */

export const CHECKS_REPO = "sim/tally";

export type CheckId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7";
export const CHECK_IDS: CheckId[] = ["C1", "C2", "C3", "C4", "C5", "C6", "C7"];

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

// --------------------------------------------------------------- base files

const SERVICES = lines(
  'import type { ServiceSpec } from "./types.ts";',
  "",
  "/** The local stack, in start order. */",
  "export const services: ServiceSpec[] = [",
  '  { name: "postgres", command: "postgres -D .tally/pg -p 5432", port: 5432 },',
  "  {",
  '    name: "gateway",',
  '    command: "node dist/gateway.js --port 8080",',
  "    port: 8080,",
  '    after: [{ service: "postgres" }],',
  "  },",
  "  {",
  '    name: "api",',
  '    command: "node dist/api.js --port 3000",',
  "    port: 3000,",
  '    after: [{ service: "postgres" }],',
  "  },",
  "  {",
  '    name: "worker",',
  '    command: "tsx watch src/jobs/worker.ts",',
  '    after: [{ service: "postgres" }, { service: "api" }],',
  "  },",
  "];",
);

const DEVSTACK_DOC = lines(
  "# Local stack",
  "",
  "`npm run dev` builds the project and starts every service in",
  "`devstack/services.ts`. `npm run dev:restart <name>` restarts one.",
  "",
  "## The worker",
  "",
  "The worker runs from source with `tsx watch` and reloads on save.",
  "It runs four jobs at a time. Set `TALLY_WORKER_CONCURRENCY` to change that.",
  "Its log is `.tally/logs/worker.log`.",
  "Stop it alone with `npm run dev:stop worker`.",
  "",
  "## Postgres",
  "",
  "Data lives in `.tally/pg`. Delete that folder to start from an empty database.",
);

const PROCESSES = lines(
  'import { type ChildProcess, spawn } from "node:child_process";',
  'import { once } from "node:events";',
  'import type { ServiceSpec } from "./types.ts";',
  "",
  "export function startService(",
  "  spec: ServiceSpec,",
  "  env: Record<string, string> = {},",
  "): ChildProcess {",
  "  return spawn(spec.command, {",
  "    shell: true,",
  '    stdio: "inherit",',
  "    env: { ...process.env, ...env },",
  "  });",
  "}",
  "",
  "/** `npm run dev:restart <name>`: stops the service, then starts it again. */",
  "export async function restartService(",
  "  spec: ServiceSpec,",
  "  running: Map<string, ChildProcess>,",
  "): Promise<ChildProcess> {",
  "  const old = running.get(spec.name);",
  "  if (old) {",
  '    old.kill("SIGTERM");',
  '    await once(old, "exit");',
  "  }",
  "  const child = startService(spec);",
  "  running.set(spec.name, child);",
  "  return child;",
  "}",
);

const SERVER_MAIN = lines(
  'import { createServer } from "node:http";',
  'import { handle } from "./routes.ts";',
  'import { drainOnSigterm } from "./shutdown.ts";',
  "",
  'const port = Number(process.argv[process.argv.indexOf("--port") + 1] ?? 3000);',
  "const health = { ok: true };",
  "const server = createServer((request, response) =>",
  "  handle(request, response, health),",
  ");",
  "drainOnSigterm(server, health);",
  "server.listen(port, () => console.log(`api listening on ${port}`));",
);

const INGEST = lines(
  'import type { Store } from "../db/store.ts";',
  'import { newSessionId } from "./ids.ts";',
  'import type { Session } from "./types.ts";',
  "",
  "type OpenRequest = { accountId: string; budgetId?: string };",
  "",
  "/** POST /sessions: opens a session for the account. */",
  "export async function openSession(",
  "  store: Store,",
  "  request: OpenRequest,",
  "): Promise<{ status: number; session?: Session; error?: string }> {",
  "  const { session } = await store.insertSession({",
  "    id: newSessionId(),",
  "    accountId: request.accountId,",
  "    startedAt: new Date().toISOString(),",
  "    units: 0,",
  "    budgetId: request.budgetId ?? null,",
  "  });",
  "  return { status: 201, session };",
  "}",
);

const REGIONS = lines(
  "/** The hosts of each region. */",
  "export const REGION_HOSTS = {",
  '  us: { api: "api.us.tally.dev" },',
  '  eu: { api: "api.eu.tally.dev" },',
  "} as const;",
  "",
  "export type Region = keyof typeof REGION_HOSTS;",
);

const USAGE_EXPORT = lines(
  'import type { Db } from "../db/client.ts";',
  'import { LEGACY_CSV } from "../flags.ts";',
  "",
  "export type Range = { from: Date; to: Date };",
  "",
  "type UsageRow = { day: string; units: number };",
  "",
  "/** Daily usage of one account, as JSON lines or CSV. */",
  "export async function exportUsage(",
  "  db: Db,",
  "  accountId: string,",
  "  range: Range,",
  '  format: "jsonl" | "csv",',
  "): Promise<string> {",
  "  const from = range.from.toISOString().slice(0, 10);",
  "  const to = range.to.toISOString().slice(0, 10);",
  "  const rows = await db.query<UsageRow>(",
  '    "SELECT day, units FROM usage WHERE account_id = $1 AND day >= $2 AND day < $3 ORDER BY day",',
  "    [accountId, from, to],",
  "  );",
  '  if (format === "jsonl") {',
  '    return rows.map((row) => JSON.stringify(row)).join("\\n");',
  "  }",
  "  if (LEGACY_CSV) {",
  "    // The old importer wanted units first, a semicolon, and no header.",
  '    return rows.map((row) => `${row.units};${row.day}`).join("\\n");',
  "  }",
  "  return [",
  '    "day,units",',
  "    ...rows.map((row) => `${row.day},${row.units}`),",
  '  ].join("\\n");',
  "}",
);

const INVOICES_EXPORT = lines(
  'import type { Db } from "../db/client.ts";',
  'import type { Range } from "./usage.ts";',
  "",
  "type InvoiceRow = { id: string; issued_on: string; total_cents: number };",
  "",
  "/** Invoices of one account issued in the range. */",
  "export async function listInvoices(",
  "  db: Db,",
  "  accountId: string,",
  "  range: Range,",
  "): Promise<InvoiceRow[]> {",
  "  const from = range.from.toISOString().slice(0, 10);",
  "  const to = range.to.toISOString().slice(0, 10);",
  "  return db.query<InvoiceRow>(",
  '    "SELECT id, issued_on, total_cents FROM invoices WHERE account_id = $1 AND issued_on >= $2 AND issued_on < $3",',
  "    [accountId, from, to],",
  "  );",
  "}",
);

const SEATS_EXPORT = lines(
  'import type { Db } from "../db/client.ts";',
  'import type { Range } from "./usage.ts";',
  "",
  "type SeatEvent = { user_id: string; kind: string; at: string };",
  "",
  "/** Seats added and removed in the range, oldest first. */",
  "export async function seatEvents(",
  "  db: Db,",
  "  accountId: string,",
  "  range: Range,",
  "): Promise<SeatEvent[]> {",
  "  const from = range.from.toISOString().slice(0, 10);",
  "  const to = range.to.toISOString().slice(0, 10);",
  "  return db.query<SeatEvent>(",
  '    "SELECT user_id, kind, at FROM seat_events WHERE account_id = $1 AND at >= $2 AND at < $3 ORDER BY at",',
  "    [accountId, from, to],",
  "  );",
  "}",
);

const FLAGS = lines(
  "/** The old CSV layout of the usage export. Off for every account since March. */",
  "export const LEGACY_CSV = false;",
  "",
  "/** Seat events in the dashboard's activity feed. */",
  "export const SEAT_FEED = true;",
);

/** The repository every change starts from. */
export const BASE_FILES: Record<string, string> = {
  "README.md": lines(
    "# tally",
    "",
    "Usage metering for API products. Clients open sessions and report usage,",
    "and tally bills it against each account's budget.",
    "",
    "## Development",
    "",
    "- `npm run dev` starts the local stack. See `docs/devstack.md`.",
    "- `npm test` runs the unit tests in `test/`.",
    "- `npm run test:integration` runs the stack with mock billing and mail servers.",
    "- `npm run check` type-checks the project.",
    "",
    "## The CLI",
    "",
    "`tally login` asks for the account's region and writes",
    "`~/.config/tally/settings.json`. Other commands read that file.",
  ),
  "CONTRIBUTING.md": lines(
    "# Contributing",
    "",
    "Run `npm run check` and `npm test` before opening a pull request.",
    "Database access goes through the `Db` type in `src/db/client.ts`.",
  ),
  "package.json": lines(
    "{",
    '  "name": "tally",',
    '  "version": "2.3.0",',
    '  "type": "module",',
    '  "scripts": {',
    '    "build": "tsc -p tsconfig.json",',
    '    "check": "tsc --noEmit",',
    '    "dev": "npm run build && node devstack/run.ts",',
    '    "dev:restart": "node devstack/restart_cli.ts",',
    '    "test": "node --test test/",',
    '    "test:integration": "node test/support/integration.ts"',
    "  },",
    '  "devDependencies": {',
    '    "@types/node": "^22.10.0",',
    '    "tsx": "^4.19.0",',
    '    "typescript": "^5.6.0"',
    "  }",
    "}",
  ),
  ".github/workflows/ci.yml": lines(
    "name: CI",
    "on:",
    "  pull_request:",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: npm ci",
    "      - run: npm run check",
    "      - run: npm test",
  ),
  "docs/devstack.md": DEVSTACK_DOC,
  "devstack/types.ts": lines(
    "/** One service of the local stack. */",
    "export type ServiceSpec = {",
    "  name: string;",
    "  command: string;",
    "  /** The port it listens on, for the health check. */",
    "  port?: number;",
    "  /** Join another service's network namespace instead of getting one. */",
    "  networkOf?: string;",
    "  /** Wait for these services to be healthy before starting. */",
    "  after?: { service: string; restart?: boolean }[];",
    "};",
  ),
  "devstack/supervisor.ts": lines(
    'import type { ServiceSpec } from "./types.ts";',
    "",
    "/** The services a service waits for. Joining a network means waiting for",
    " * its owner, unless the spec lists `after` entries of its own. */",
    "export function startsAfter(spec: ServiceSpec): string[] {",
    "  if (spec.after) return spec.after.map((entry) => entry.service);",
    "  return spec.networkOf ? [spec.networkOf] : [];",
    "}",
    "",
    "/** The services to restart after `name` restarts. A service in another's",
    " * network namespace keeps the old namespace until it restarts too. */",
    "export function restartsWith(name: string, specs: ServiceSpec[]): string[] {",
    "  return specs",
    "    .filter((spec) =>",
    "      spec.after",
    "        ? spec.after.some((entry) => entry.service === name && entry.restart)",
    "        : spec.networkOf === name,",
    "    )",
    "    .map((spec) => spec.name);",
    "}",
  ),
  "devstack/services.ts": SERVICES,
  "devstack/processes.ts": PROCESSES,
  "devstack/run.ts": lines(
    'import type { ChildProcess } from "node:child_process";',
    'import { setTimeout as sleep } from "node:timers/promises";',
    'import { startService } from "./processes.ts";',
    'import { services } from "./services.ts";',
    'import { startsAfter } from "./supervisor.ts";',
    "",
    "async function waitHealthy(name: string): Promise<void> {",
    "  const port = services.find((spec) => spec.name === name)?.port;",
    "  if (port === undefined) return;",
    "  for (let attempt = 0; attempt < 100; attempt++) {",
    "    try {",
    "      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;",
    "    } catch {",
    "      // Not listening yet.",
    "    }",
    "    await sleep(200);",
    "  }",
    "  throw new Error(`${name} did not become healthy`);",
    "}",
    "",
    "/** `npm run dev`: starts each service once the ones it waits for are up. */",
    "export async function startStack(",
    "  env: Record<string, string> = {},",
    "): Promise<Map<string, ChildProcess>> {",
    "  const running = new Map<string, ChildProcess>();",
    "  for (const spec of services) {",
    "    for (const name of startsAfter(spec)) await waitHealthy(name);",
    "    running.set(spec.name, startService(spec, env));",
    "  }",
    "  return running;",
    "}",
  ),
  "test/support/mock_servers.ts": lines(
    'import { createServer, type Server } from "node:http";',
    "",
    "/** Fake billing and mail providers for `npm run test:integration`. */",
    "export const MOCK_PORTS = { billing: 4010, mail: 4011 } as const;",
    "",
    "export function startMocks(): Server[] {",
    "  return Object.values(MOCK_PORTS).map((port) =>",
    '    createServer((_, response) => response.end("{}")).listen(port),',
    "  );",
    "}",
  ),
  "test/support/integration.ts": lines(
    'import { spawnSync } from "node:child_process";',
    'import { startStack } from "../../devstack/run.ts";',
    'import { MOCK_PORTS, startMocks } from "./mock_servers.ts";',
    "",
    "/** `npm run test:integration`: the mocks, the stack, then the tests. */",
    "const mocks = startMocks();",
    "const stack = await startStack({",
    "  BILLING_URL: `http://127.0.0.1:${MOCK_PORTS.billing}`,",
    "  MAIL_URL: `http://127.0.0.1:${MOCK_PORTS.mail}`,",
    "});",
    'const result = spawnSync("node", ["--test", "test/integration/"], {',
    '  stdio: "inherit",',
    "});",
    'for (const child of stack.values()) child.kill("SIGTERM");',
    "for (const server of mocks) server.close();",
    "process.exitCode = result.status ?? 1;",
  ),
  "src/db/client.ts": lines(
    "/** The one way the code talks to Postgres. */",
    "export type Db = {",
    "  query<T>(sql: string, params: unknown[]): Promise<T[]>;",
    "};",
  ),
  "src/db/store.ts": lines(
    'import type { Session } from "../sessions/types.ts";',
    "",
    "export type Store = {",
    "  /** Inserts the session, or returns the one already stored under the same",
    "   * account and id, with `created: false`. */",
    "  insertSession(",
    "    session: Session,",
    "  ): Promise<{ session: Session; created: boolean }>;",
    "  listSessions(accountId: string, limit: number): Promise<Session[]>;",
    "};",
  ),
  "src/sessions/types.ts": lines(
    "export type Session = {",
    "  id: string;",
    "  accountId: string;",
    "  startedAt: string;",
    "  units: number;",
    "  budgetId: string | null;",
    "};",
  ),
  "src/sessions/ids.ts": lines(
    'import { randomBytes } from "node:crypto";',
    "",
    '/** A new session id: "ses_" and eight hex digits. */',
    "export function newSessionId(): string {",
    '  return `ses_${randomBytes(4).toString("hex")}`;',
    "}",
  ),
  "src/sessions/ingest.ts": INGEST,
  "src/sessions/recent.ts": lines(
    'import { shortId } from "../web/format.ts";',
    'import type { Session } from "./types.ts";',
    "",
    "/** The account's latest sessions, keyed by the id the dashboard shows and",
    " * `tally session open <id>` accepts. */",
    "export function recentSessions(sessions: Session[]): Map<string, Session> {",
    "  const byId = new Map<string, Session>();",
    "  for (const session of sessions) byId.set(shortId(session.id), session);",
    "  return byId;",
    "}",
  ),
  "src/web/format.ts": lines(
    "/** The id as the dashboard shows it. Session ids are 12 characters, so this",
    " * keeps the whole id. */",
    "export function shortId(id: string): string {",
    "  return id.slice(0, 12);",
    "}",
    "",
    "export function formatUnits(units: number): string {",
    '  return units.toLocaleString("en-US");',
    "}",
  ),
  "src/server/shutdown.ts": lines(
    'import type { Server } from "node:http";',
    "",
    "/** How long a stopping server keeps serving after SIGTERM, so the load",
    " * balancer sees the failing health check and stops sending traffic first. */",
    "export const DRAIN_MS = Number(process.env.TALLY_DRAIN_MS ?? 10_000);",
    "",
    "/** On SIGTERM: fail the health check, keep serving for DRAIN_MS, then close",
    " * the listener and exit. */",
    "export function drainOnSigterm(server: Server, health: { ok: boolean }): void {",
    '  process.once("SIGTERM", () => {',
    "    health.ok = false;",
    "    setTimeout(() => server.close(() => process.exit(0)), DRAIN_MS);",
    "  });",
    "}",
  ),
  "src/server/routes.ts": lines(
    'import type { IncomingMessage, ServerResponse } from "node:http";',
    "",
    "export function handle(",
    "  request: IncomingMessage,",
    "  response: ServerResponse,",
    "  health: { ok: boolean },",
    "): void {",
    '  if (request.url === "/health") {',
    "    response.statusCode = health.ok ? 200 : 503;",
    "    response.end();",
    "    return;",
    "  }",
    "  response.statusCode = 404;",
    "  response.end();",
    "}",
  ),
  "src/server/main.ts": SERVER_MAIN,
  "src/cli/regions.ts": REGIONS,
  "src/cli/settings.ts": lines(
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { homedir } from "node:os";',
    'import { dirname, join } from "node:path";',
    'import { REGION_HOSTS, type Region } from "./regions.ts";',
    "",
    'export const SETTINGS_PATH = join(homedir(), ".config", "tally", "settings.json");',
    "",
    "export type Settings = {",
    "  region: Region;",
    "  token: string;",
    "  /** The region's hosts, one entry per key of `REGION_HOSTS`. */",
    "  hosts: Record<string, string | undefined>;",
    "};",
    "",
    "/** What `tally login` writes, once. Other commands only read it. */",
    "export function buildSettings(region: Region, token: string): Settings {",
    "  return { region, token, hosts: { ...REGION_HOSTS[region] } };",
    "}",
    "",
    "export function writeSettings(settings: Settings, path = SETTINGS_PATH): void {",
    "  mkdirSync(dirname(path), { recursive: true });",
    "  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\\n`, { mode: 0o600 });",
    "}",
    "",
    "export function readSettings(path = SETTINGS_PATH): Settings {",
    '  return JSON.parse(readFileSync(path, "utf8")) as Settings;',
    "}",
  ),
  "src/cli/login.ts": lines(
    'import type { Region } from "./regions.ts";',
    'import { buildSettings, writeSettings } from "./settings.ts";',
    "",
    "/** `tally login --region=eu`: saves the token and the region's hosts. */",
    "export function login(region: Region, token: string): void {",
    "  writeSettings(buildSettings(region, token));",
    "}",
  ),
  "src/cli/report.ts": lines(
    'import { readSettings } from "./settings.ts";',
    "",
    "/** `tally report <units>`: adds units to the current session. */",
    "export async function reportUnits(",
    "  units: number,",
    "  settings = readSettings(),",
    "): Promise<void> {",
    "  const response = await fetch(`https://${settings.hosts.api}/v1/units`, {",
    '    method: "POST",',
    "    headers: {",
    "      authorization: `Bearer ${settings.token}`,",
    '      "content-type": "application/json",',
    "    },",
    "    body: JSON.stringify({ units }),",
    "  });",
    "  if (!response.ok) throw new Error(`report failed: HTTP ${response.status}`);",
    "}",
  ),
  "src/flags.ts": FLAGS,
  "src/exports/usage.ts": USAGE_EXPORT,
  "src/exports/invoices.ts": INVOICES_EXPORT,
  "src/exports/seats.ts": SEATS_EXPORT,
};

// ------------------------------------------------------------------ changes

/** A place a finding must touch to count as the catch: from the first line of
 * the file that contains `from` to the first line at or after it that
 * contains `to`. In an unchanged file it marks the evidence. */
export type Span = { path: string; from: string; to?: string };

/** One change, committed on a branch of its own over the base files. */
export type Change = {
  /** The label in the report, never shown to the model. */
  name: string;
  files: Record<string, string>;
  /** The intent the review gets with `--intent-file`, the same in both arms. */
  intent?: string;
};

/** A seeded change and its fixed twin, for one check. */
export type Pair = {
  check: CheckId;
  /** The issue the shape comes from. */
  from: string;
  seeded: Change;
  fixed: Change;
  /** Where the defect is, in the seeded change's files. */
  spans: Span[];
  /** Paths whose content differs between the two changes, with the most
   * lines that may differ in each. Anything else differing fails a check. */
  differs: Record<string, number>;
  /** Text in the seeded change's prompt that the fake reviewer anchors its
   * finding on, and the test that tells the seeded prompt from the twin's. */
  fake: { path: string; marker: string; seeded(prompt: string): boolean };
};

const has = (prompt: string, text: string) => prompt.includes(text);
const file = (path: string) => `\nFILE: ${path}\n`;

// ---- C1: one source of truth (issue 60)

const PORTS_HEAD = [
  "/** Every port the local stack and the integration tests listen on. Set",
  " * TALLY_PORT_OFFSET to shift all of them, so two checkouts can run side by",
  " * side. */",
  "const BASE_PORTS = {",
  "  postgres: 5432,",
  "  gateway: 8080,",
  "  api: 3000,",
];
const PORTS_TAIL = [
  "} as const;",
  "",
  "export type PortName = keyof typeof BASE_PORTS;",
  "",
  "export function portOffset(env = process.env): number {",
  "  const offset = Number(env.TALLY_PORT_OFFSET ?? 0);",
  "  if (!Number.isInteger(offset) || offset < 0 || offset > 1000) {",
  "    throw new Error(",
  "      `TALLY_PORT_OFFSET must be a whole number from 0 to 1000, got ${env.TALLY_PORT_OFFSET}`,",
  "    );",
  "  }",
  "  return offset;",
  "}",
  "",
  "export function portOf(name: PortName, env = process.env): number {",
  "  return BASE_PORTS[name] + portOffset(env);",
  "}",
];

const PORTED_SERVICES = SERVICES.replace(
  'import type { ServiceSpec } from "./types.ts";',
  'import { portOf } from "./ports.ts";\nimport type { ServiceSpec } from "./types.ts";',
)
  .replace(
    '  { name: "postgres", command: "postgres -D .tally/pg -p 5432", port: 5432 },',
    [
      "  {",
      '    name: "postgres",',
      '    command: `postgres -D .tally/pg -p ${portOf("postgres")}`,',
      '    port: portOf("postgres"),',
      "  },",
    ].join("\n"),
  )
  .replace(
    '    command: "node dist/gateway.js --port 8080",\n    port: 8080,',
    '    command: `node dist/gateway.js --port ${portOf("gateway")}`,\n    port: portOf("gateway"),',
  )
  .replace(
    '    command: "node dist/api.js --port 3000",\n    port: 3000,',
    '    command: `node dist/api.js --port ${portOf("api")}`,\n    port: portOf("api"),',
  );

const C1: Pair = {
  check: "C1",
  from: "issue 60",
  seeded: {
    name: "c1-seeded",
    files: {
      "devstack/ports.ts": lines(...PORTS_HEAD, ...PORTS_TAIL),
      "devstack/services.ts": PORTED_SERVICES,
    },
  },
  fixed: {
    name: "c1-fixed",
    files: {
      "devstack/ports.ts": lines(
        ...PORTS_HEAD,
        "  mockBilling: 4010,",
        "  mockMail: 4011,",
        ...PORTS_TAIL,
      ),
      "devstack/services.ts": PORTED_SERVICES,
      "test/support/mock_servers.ts": BASE_FILES[
        "test/support/mock_servers.ts"
      ]!.replace(
        'import { createServer, type Server } from "node:http";',
        'import { createServer, type Server } from "node:http";\nimport { portOf } from "../../devstack/ports.ts";',
      ).replace(
        "export const MOCK_PORTS = { billing: 4010, mail: 4011 } as const;",
        'export const MOCK_PORTS = {\n  billing: portOf("mockBilling"),\n  mail: portOf("mockMail"),\n} as const;',
      ),
    },
  },
  spans: [
    { path: "devstack/ports.ts", from: "/** Every port", to: "} as const;" },
    { path: "test/support/mock_servers.ts", from: "export const MOCK_PORTS" },
  ],
  differs: { "devstack/ports.ts": 2, "test/support/mock_servers.ts": 6 },
  fake: {
    path: "devstack/ports.ts",
    marker: "const BASE_PORTS = {",
    seeded: (prompt) =>
      has(prompt, file("devstack/ports.ts")) &&
      !has(prompt, file("test/support/mock_servers.ts")),
  },
};

// ---- C2: odd sibling (issues 63 and 66)

const siblings = (after: string) =>
  SERVICES.replace(
    '    command: "node dist/gateway.js --port 8080",',
    '    command: "node dist/gateway.js --port 8080 --publish 8081,8082,8083",',
  ).replace(
    "];",
    [
      "  {",
      '    name: "dashboard",',
      '    command: "node dist/dashboard.js --port 8081",',
      '    networkOf: "gateway",',
      `    after: [${after}],`,
      "  },",
      "  {",
      '    name: "docs-preview",',
      '    command: "node dist/docs_preview.js --port 8082",',
      '    networkOf: "gateway",',
      `    after: [${after}],`,
      "  },",
      "  {",
      '    name: "inspector",',
      '    command: "node dist/inspector.js --port 8083",',
      '    networkOf: "gateway",',
      "  },",
      "];",
    ].join("\n"),
  );

const C2: Pair = {
  check: "C2",
  from: "issues 63 and 66",
  seeded: {
    name: "c2-seeded",
    files: { "devstack/services.ts": siblings('{ service: "gateway" }') },
  },
  fixed: {
    name: "c2-fixed",
    files: {
      "devstack/services.ts": siblings('{ service: "gateway", restart: true }'),
    },
  },
  spans: [
    {
      path: "devstack/services.ts",
      from: 'name: "dashboard"',
      to: 'name: "inspector"',
    },
  ],
  differs: { "devstack/services.ts": 2 },
  fake: {
    path: "devstack/services.ts",
    marker: 'after: [{ service: "gateway" }],',
    seeded: (prompt) => has(prompt, 'after: [{ service: "gateway" }],'),
  },
};

// ---- C3: new writer (issue 66)

const clientIds = (pattern: string, words: string) =>
  INGEST.replace(
    "type OpenRequest = { accountId: string; budgetId?: string };",
    [
      "type OpenRequest = { accountId: string; budgetId?: string; id?: string };",
      "",
      "/** An id the client may choose, so a retried request gets the session the",
      " * first one opened instead of a second one. */",
      `const CLIENT_ID = ${pattern};`,
    ].join("\n"),
  )
    .replace(
      "): Promise<{ status: number; session?: Session; error?: string }> {\n  const { session } = await store.insertSession({\n    id: newSessionId(),",
      [
        "): Promise<{ status: number; session?: Session; error?: string }> {",
        "  if (request.id !== undefined && !CLIENT_ID.test(request.id)) {",
        `    return { status: 400, error: "id must be ${words} letters, digits, - or _" };`,
        "  }",
        "  const { session, created } = await store.insertSession({",
        "    id: request.id ?? newSessionId(),",
      ].join("\n"),
    )
    .replace(
      "  return { status: 201, session };",
      "  return { status: created ? 201 : 200, session };",
    );

const C3: Pair = {
  check: "C3",
  from: "issue 66",
  seeded: {
    name: "c3-seeded",
    files: {
      "src/sessions/ingest.ts": clientIds("/^[A-Za-z0-9_-]{8,64}$/", "8 to 64"),
    },
  },
  fixed: {
    name: "c3-fixed",
    files: {
      "src/sessions/ingest.ts": clientIds("/^[A-Za-z0-9_-]{8,12}$/", "8 to 12"),
    },
  },
  spans: [
    { path: "src/sessions/ingest.ts", from: "/** An id the client may choose" },
    { path: "src/sessions/ingest.ts", from: "if (request.id !== undefined" },
    {
      path: "src/sessions/ingest.ts",
      from: "id: request.id ?? newSessionId()",
    },
    { path: "src/web/format.ts", from: "/** The id as", to: "id.slice(0, 12)" },
    { path: "src/sessions/recent.ts", from: "byId.set(shortId" },
  ],
  differs: { "src/sessions/ingest.ts": 2 },
  fake: {
    path: "src/sessions/ingest.ts",
    marker: "const CLIENT_ID",
    seeded: (prompt) => has(prompt, "{8,64}"),
  },
};

// ---- C4: old copies (issue 64)

const ingestRegions = (extra: string[]) =>
  REGIONS.replace(
    '  us: { api: "api.us.tally.dev" },\n  eu: { api: "api.eu.tally.dev" },',
    [
      '  us: { api: "api.us.tally.dev", ingest: "ingest.us.tally.dev" },',
      '  eu: { api: "api.eu.tally.dev", ingest: "ingest.eu.tally.dev" },',
    ].join("\n"),
  ).replace(
    "export type Region = keyof typeof REGION_HOSTS;",
    ["export type Region = keyof typeof REGION_HOSTS;", "", ...extra].join(
      "\n",
    ),
  );

const upload = (importName: string, fallback: string) =>
  lines(
    'import { readFileSync } from "node:fs";',
    `import { ${importName} } from "./regions.ts";`,
    'import { readSettings } from "./settings.ts";',
    "",
    "/** `tally upload <file>`: sends a batch of usage events to the region's",
    " * ingest host. */",
    "export async function uploadEvents(",
    "  path: string,",
    "  settings = readSettings(),",
    "): Promise<void> {",
    `  const host = settings.hosts.ingest ?? ${fallback};`,
    "  const response = await fetch(`https://${host}/v1/events`, {",
    '    method: "POST",',
    "    headers: {",
    "      authorization: `Bearer ${settings.token}`,",
    '      "content-type": "application/x-ndjson",',
    "    },",
    "    body: readFileSync(path),",
    "  });",
    "  if (!response.ok) throw new Error(`upload failed: HTTP ${response.status}`);",
    "}",
  );

const C4: Pair = {
  check: "C4",
  from: "issue 64",
  seeded: {
    name: "c4-seeded",
    files: {
      "src/cli/regions.ts": ingestRegions([
        "/** The ingest host when the settings file names none. */",
        'export const DEFAULT_INGEST_HOST = "ingest.us.tally.dev";',
      ]),
      "src/cli/upload.ts": upload("DEFAULT_INGEST_HOST", "DEFAULT_INGEST_HOST"),
    },
  },
  fixed: {
    name: "c4-fixed",
    files: {
      "src/cli/regions.ts": ingestRegions([
        "/** The ingest host when the settings file names none. */",
        "export const ingestHostFor = (region: Region) => REGION_HOSTS[region].ingest;",
      ]),
      "src/cli/upload.ts": upload(
        "ingestHostFor",
        "ingestHostFor(settings.region)",
      ),
    },
  },
  spans: [
    { path: "src/cli/upload.ts", from: "const host = settings.hosts.ingest" },
    { path: "src/cli/regions.ts", from: "export const DEFAULT_INGEST_HOST" },
  ],
  differs: { "src/cli/regions.ts": 1, "src/cli/upload.ts": 2 },
  fake: {
    path: "src/cli/upload.ts",
    marker: "settings.hosts.ingest ??",
    seeded: (prompt) => has(prompt, "?? DEFAULT_INGEST_HOST"),
  },
};

// ---- C5: retry on a conflict (issue 62)

const LISTEN = lines(
  'import type { Server } from "node:http";',
  "",
  "/** Listens on `port`, trying again while the port is taken. On a dev",
  " * restart the old process lets go of the port as soon as it gets SIGTERM,",
  " * so a few short tries are enough. */",
  "export async function listenWithRetry(",
  "  server: Server,",
  "  port: number,",
  "  attempts = 5,",
  "  delayMs = 200,",
  "): Promise<void> {",
  "  for (let attempt = 1; ; attempt++) {",
  "    try {",
  "      await new Promise<void>((resolve, reject) => {",
  '        server.once("error", reject);',
  "        server.listen(port, () => {",
  '          server.off("error", reject);',
  "          resolve();",
  "        });",
  "      });",
  "      return;",
  "    } catch (error) {",
  "      const code = (error as NodeJS.ErrnoException).code;",
  '      if (code !== "EADDRINUSE" || attempt === attempts) throw error;',
  "      await new Promise((resolve) => setTimeout(resolve, delayMs));",
  "    }",
  "  }",
  "}",
);

const RETRY_MAIN = SERVER_MAIN.replace(
  'import { drainOnSigterm } from "./shutdown.ts";',
  'import { listenWithRetry } from "./listen.ts";\nimport { drainOnSigterm } from "./shutdown.ts";',
).replace(
  "server.listen(port, () => console.log(`api listening on ${port}`));",
  "await listenWithRetry(server, port);\nconsole.log(`api listening on ${port}`);",
);

const quickRestart = (drain: boolean) =>
  PROCESSES.replace('import { once } from "node:events";\n', "")
    .replace(
      "    env: { ...process.env, ...env },",
      drain
        ? [
            "    // Nothing balances traffic in the local stack, so a stopping",
            "    // service may let go of its port at once.",
            '    env: { ...process.env, TALLY_DRAIN_MS: "0", ...env },',
          ].join("\n")
        : "    env: { ...process.env, ...env },",
    )
    .replace(
      "/** `npm run dev:restart <name>`: stops the service, then starts it again. */",
      [
        "/** `npm run dev:restart <name>`: stops the service and starts the new",
        " * process at once. The new one retries its port until the old one lets",
        " * go (`listenWithRetry`), so a restart no longer waits for the exit. */",
      ].join("\n"),
    )
    .replace(
      '  if (old) {\n    old.kill("SIGTERM");\n    await once(old, "exit");\n  }',
      '  old?.kill("SIGTERM");',
    );

const C5: Pair = {
  check: "C5",
  from: "issue 62",
  seeded: {
    name: "c5-seeded",
    files: {
      "devstack/processes.ts": quickRestart(false),
      "src/server/listen.ts": LISTEN,
      "src/server/main.ts": RETRY_MAIN,
    },
  },
  fixed: {
    name: "c5-fixed",
    files: {
      "devstack/processes.ts": quickRestart(true),
      "src/server/listen.ts": LISTEN,
      "src/server/main.ts": RETRY_MAIN,
    },
  },
  spans: [
    {
      path: "devstack/processes.ts",
      from: "/** `npm run dev:restart <name>`",
      to: "const child = startService(spec);",
    },
    {
      path: "src/server/listen.ts",
      from: "/** Listens on `port`",
      to: "delayMs = 200,",
    },
    { path: "src/server/main.ts", from: "await listenWithRetry" },
    {
      path: "src/server/shutdown.ts",
      from: "/** How long a stopping",
      to: "export const DRAIN_MS",
    },
  ],
  differs: { "devstack/processes.ts": 3 },
  fake: {
    path: "src/server/listen.ts",
    marker: "attempts = 5,",
    seeded: (prompt) =>
      has(prompt, file("src/server/listen.ts")) &&
      !has(prompt, "TALLY_DRAIN_MS"),
  },
};

// ---- C6: stale statement (issue 61)

/** The local review diff shows three unchanged lines around each change, and
 * nothing in the product reads a Markdown file the diff does not show. The
 * stale sentence is therefore three lines above the new one: in front of the
 * model, but only as context. */
const STALE =
  "The worker runs from source with `tsx watch` and reloads on save.";
const builtWorkerDoc = (fixed: boolean) =>
  DEVSTACK_DOC.replace(
    STALE,
    fixed
      ? "The worker runs the built bundle in `dist/jobs/worker.js`, like production."
      : STALE,
  ).replace(
    "Its log is `.tally/logs/worker.log`.",
    [
      "Its log is `.tally/logs/worker.log`.",
      "After an edit under `src/jobs/`, run `npm run build` and `npm run dev:restart worker`.",
    ].join("\n"),
  );

const BUILT_WORKER = SERVICES.replace(
  '    command: "tsx watch src/jobs/worker.ts",',
  '    command: "node dist/jobs/worker.js",',
);

const C6: Pair = {
  check: "C6",
  from: "issue 61",
  seeded: {
    name: "c6-seeded",
    files: {
      "devstack/services.ts": BUILT_WORKER,
      "docs/devstack.md": builtWorkerDoc(false),
    },
  },
  fixed: {
    name: "c6-fixed",
    files: {
      "devstack/services.ts": BUILT_WORKER,
      "docs/devstack.md": builtWorkerDoc(true),
    },
  },
  spans: [{ path: "docs/devstack.md", from: STALE, to: "After an edit under" }],
  differs: { "docs/devstack.md": 1 },
  fake: {
    path: "docs/devstack.md",
    marker: "After an edit under `src/jobs/`",
    seeded: (prompt) =>
      has(prompt, "After an edit under `src/jobs/`") &&
      !has(prompt, "runs the built bundle"),
  },
};

// ---- C7: outside the goal (issue 65)

const RANGE = lines(
  'import type { Range } from "./usage.ts";',
  "",
  "const day = (date: Date) => date.toISOString().slice(0, 10);",
  "",
  "/** The account and the first and last day of a range, as the export",
  " * queries take them: `$1`, `$2` and `$3`. */",
  "export function rangeParams(",
  "  accountId: string,",
  "  range: Range,",
  "): [string, string, string] {",
  "  return [accountId, day(range.from), day(range.to)];",
  "}",
);

const TWO_LINES =
  "  const from = range.from.toISOString().slice(0, 10);\n  const to = range.to.toISOString().slice(0, 10);\n";

const withRangeParams = (text: string) =>
  text
    .replace(
      'import type { Range } from "./usage.ts";',
      'import { rangeParams } from "./range.ts";\nimport type { Range } from "./usage.ts";',
    )
    .replace(TWO_LINES, "")
    .replace(
      "    [accountId, from, to],",
      "    rangeParams(accountId, range),",
    );

const C7_FILES = {
  "src/exports/range.ts": RANGE,
  "src/exports/usage.ts": USAGE_EXPORT.replace(
    'import { LEGACY_CSV } from "../flags.ts";',
    'import { rangeParams } from "./range.ts";',
  )
    .replace(TWO_LINES, "")
    .replace("    [accountId, from, to],", "    rangeParams(accountId, range),")
    .replace(
      [
        "  if (LEGACY_CSV) {",
        "    // The old importer wanted units first, a semicolon, and no header.",
        '    return rows.map((row) => `${row.units};${row.day}`).join("\\n");',
        "  }",
        "",
      ].join("\n"),
      "",
    ),
  "src/exports/invoices.ts": withRangeParams(INVOICES_EXPORT),
  "src/exports/seats.ts": withRangeParams(SEATS_EXPORT),
  "src/flags.ts": FLAGS.replace(
    "/** The old CSV layout of the usage export. Off for every account since March. */\nexport const LEGACY_CSV = false;\n\n",
    "",
  ),
};

const GOAL =
  "Remove the dead legacy CSV branch from exportUsage. The LEGACY_CSV flag has been off for every account since March.";

const C7: Pair = {
  check: "C7",
  from: "issue 65",
  seeded: { name: "c7-seeded", files: C7_FILES, intent: GOAL },
  fixed: {
    name: "c7-fixed",
    files: C7_FILES,
    intent: `${GOAL} Also move the date range parameters that the usage, invoice and seat exports build into one helper, rangeParams, without changing a query.`,
  },
  spans: [
    { path: "src/exports/range.ts", from: "import type", to: "return [" },
    {
      path: "src/exports/invoices.ts",
      from: "import { rangeParams }",
      to: "rangeParams(accountId, range)",
    },
    {
      path: "src/exports/seats.ts",
      from: "import { rangeParams }",
      to: "rangeParams(accountId, range)",
    },
  ],
  differs: {},
  fake: {
    path: "src/exports/range.ts",
    marker: "export function rangeParams(",
    seeded: (prompt) =>
      has(prompt, file("src/exports/range.ts")) &&
      !has(prompt, "one helper, rangeParams"),
  },
};

export const PAIRS: Pair[] = [C1, C2, C3, C4, C5, C6, C7];

// ------------------------------------------------------------ clean changes

/** Changes that touch none of the check shapes: a second noise control. */
export const CLEAN: Change[] = [
  {
    name: "clean-duration",
    files: {
      "src/web/duration.ts": lines(
        '/** A duration as the dashboard shows it: "45s", "3m 05s" or "2h 07m". */',
        "export function formatDuration(ms: number): string {",
        "  if (!Number.isFinite(ms) || ms < 0) {",
        "    throw new RangeError(`not a duration: ${ms}`);",
        "  }",
        "  const seconds = Math.floor(ms / 1000);",
        "  if (seconds < 60) return `${seconds}s`;",
        "  const minutes = Math.floor(seconds / 60);",
        "  if (minutes < 60) {",
        '    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;',
        "  }",
        '  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;',
        "}",
      ),
      "test/duration.test.ts": lines(
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { formatDuration } from "../src/web/duration.ts";',
        "",
        'test("seconds, minutes and hours", () => {',
        '  assert.equal(formatDuration(0), "0s");',
        '  assert.equal(formatDuration(45_000), "45s");',
        '  assert.equal(formatDuration(185_000), "3m 05s");',
        '  assert.equal(formatDuration(7_620_000), "2h 07m");',
        "});",
        "",
        'test("a negative duration is refused", () => {',
        "  assert.throws(() => formatDuration(-1), RangeError);",
        "});",
      ),
    },
  },
  {
    name: "clean-supervisor-tests",
    files: {
      "test/supervisor.test.ts": lines(
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { restartsWith, startsAfter } from "../devstack/supervisor.ts";',
        'import type { ServiceSpec } from "../devstack/types.ts";',
        "",
        "const specs: ServiceSpec[] = [",
        '  { name: "gateway", command: "gateway" },',
        '  { name: "panel", command: "panel", networkOf: "gateway" },',
        "  {",
        '    name: "proxy",',
        '    command: "proxy",',
        '    networkOf: "gateway",',
        '    after: [{ service: "gateway", restart: true }],',
        "  },",
        "];",
        "",
        'test("joining a network waits for its owner", () => {',
        '  assert.deepEqual(startsAfter(specs[1]!), ["gateway"]);',
        "  assert.deepEqual(startsAfter(specs[0]!), []);",
        "});",
        "",
        'test("a restart reaches the services in the owner\'s network", () => {',
        '  assert.deepEqual(restartsWith("gateway", specs), ["panel", "proxy"]);',
        "});",
      ),
    },
  },
  {
    name: "clean-invoice-order",
    files: {
      "src/exports/invoices.ts": INVOICES_EXPORT.replace(
        "/** Invoices of one account issued in the range. */",
        "/** Invoices of one account issued in the range, oldest first. */",
      ).replace(
        "AND issued_on < $3",
        "AND issued_on < $3 ORDER BY issued_on, id",
      ),
    },
  },
];

/** The files of a change as the checkout holds them: the base with the
 * change's files written over it. */
export function treeOf(change: Change): Record<string, string> {
  return { ...BASE_FILES, ...change.files };
}

/** A span as line numbers in the seeded change's files. Throws when a marker
 * is missing, so a scenario edit that moves the defect cannot pass quietly. */
export function resolveSpan(
  tree: Record<string, string>,
  span: Span,
): { path: string; from: number; to: number } {
  const rows = (tree[span.path] ?? "").split("\n");
  const from = rows.findIndex((row) => row.includes(span.from));
  if (from < 0) throw new Error(`${span.path}: no line holds ${span.from}`);
  let to = from;
  if (span.to !== undefined) {
    to = rows.findIndex(
      (row, index) => index >= from && row.includes(span.to!),
    );
    if (to < 0) throw new Error(`${span.path}: no line holds ${span.to}`);
  }
  return { path: span.path, from: from + 1, to: to + 1 };
}
