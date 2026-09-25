import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  APP_PERMISSIONS,
  ENDPOINTS,
  endpointFor,
  permissionTable,
  refusalHint,
} from "./permissions.ts";
import { APP_MANIFEST_PERMISSIONS } from "./app_manifest.ts";
import { GitHubHttpError, httpError } from "./client.ts";

const SRC = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) => !/^(testing|benchmark)[\\/]/.test(name))
    .map((name) => join(SRC, name));
}

const PART = "(?:[^`\\s$]|\\$\\{[^}]*\\})*";
const URL_PART = "(?:[^`\"'\\s$]|\\$\\{[^}]*\\})*";

/** `repos/${owner}/${repo}/pulls?x=1` becomes `repos/{x}/pulls`: every
 * interpolation is one placeholder and the query string is dropped. */
function shape(raw: string): string {
  return raw
    .replace(/\$\{owner\}\/\$\{repo\}/g, "{x}")
    .replace(/\$\{[^}]*\}/g, "{x}")
    .replace(/\{[a-z]+\}/g, "{x}")
    .replace(/\{x\}\.\.\.\{x\}/g, "{x}")
    .replace(/\?.*$/, "");
}

function endpointsInSource(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const patterns = [
      new RegExp(`\`(repos/${PART})\``, "g"),
      new RegExp(`https://api\\.github\\.com/(${URL_PART})`, "g"),
      new RegExp(`\\$\\{API\\}/(${URL_PART})`, "g"),
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const value = shape(match[1]!);
        // `${API}/${endpoint}` is the generic caller, not an endpoint.
        if (value === "{x}") continue;
        found.set(value, file);
      }
    }
  }
  return found;
}

test("every GitHub endpoint the source calls has a permission entry", () => {
  const known = new Set(ENDPOINTS.map((endpoint) => shape(endpoint.pattern)));
  const missing = [...endpointsInSource()]
    .filter(([value]) => !known.has(value))
    .map(([value, file]) => `${value} (${file})`);
  if (missing.length > 0) {
    throw new Error(
      `add these to ENDPOINTS in src/github/permissions.ts:\n${missing.join("\n")}`,
    );
  }
});

test("the scan sees the endpoints it is meant to guard", () => {
  const found = endpointsInSource();
  for (const wanted of [
    "repos/{x}/pulls/{x}/reviews",
    "repos/{x}/check-runs/{x}",
    "repos/{x}/compare/{x}",
    "app/installations/{x}/access_tokens",
  ]) {
    if (!found.has(wanted)) throw new Error(`the scan missed ${wanted}`);
  }
});

test("the App permissions derived from the calls match the manifest", () => {
  const want = {
    metadata: "read",
    contents: "read",
    issues: "write",
    pull_requests: "write",
    checks: "write",
  };
  if (
    JSON.stringify(sorted(APP_PERMISSIONS)) !== JSON.stringify(sorted(want))
  ) {
    throw new Error(`derived ${JSON.stringify(APP_PERMISSIONS)}`);
  }
  if (
    JSON.stringify(sorted(APP_MANIFEST_PERMISSIONS)) !==
    JSON.stringify(sorted(want))
  ) {
    throw new Error("the manifest drifted from the derived permissions");
  }
});

function sorted(value: Record<string, string>): [string, string][] {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
}

test("endpointFor matches real endpoints with queries and nested paths", () => {
  const cases: [string, string, string | undefined][] = [
    ["GET", "repos/o/r/pulls/4/files?per_page=100&page=2", "pull_requests"],
    ["GET", "repos/o/r/contents/src/a%20b.ts?ref=main", "contents"],
    ["GET", "repos/o/r/compare/abc...main", "contents"],
    ["POST", "repos/o/r/check-runs", "checks"],
    ["PATCH", "repos/o/r/check-runs/9", "checks"],
    ["GET", "repos/o/r", "metadata"],
    ["GET", "user", undefined],
  ];
  for (const [method, endpoint, permission] of cases) {
    const found = endpointFor(method, endpoint);
    if (!found) throw new Error(`no entry for ${method} ${endpoint}`);
    if (found.permission !== permission) {
      throw new Error(`${endpoint} needs ${found.permission}`);
    }
  }
  if (endpointFor("DELETE", "repos/o/r")) throw new Error("matched DELETE");
});

test("the refusal hint names the endpoint and the missing permission", () => {
  const read = refusalHint("GET", "repos/o/r/pulls/4", "token");
  if (
    read !==
    "GitHub refused GET repos/o/r/pulls/4. The token needs Pull requests: Read."
  ) {
    throw new Error(read);
  }
  const app = refusalHint("POST", "repos/o/r/pulls/4/reviews", "App");
  if (
    app !==
    "GitHub refused POST repos/o/r/pulls/4/reviews. The GitHub App needs Pull requests: Read and write."
  ) {
    throw new Error(app);
  }
  const check = refusalHint("POST", "repos/o/r/check-runs", "token");
  if (!/Only a GitHub App can do this/.test(check)) throw new Error(check);
  const unknown = refusalHint("GET", "somewhere/else", "token");
  if (unknown !== "GitHub refused GET somewhere/else.")
    throw new Error(unknown);
});

test("httpError adds a hint on 403 and 404 and leaves other statuses alone", async () => {
  const forbidden = await httpError(
    new Response("nope", { status: 403 }),
    "GET",
    "repos/o/r/pulls/4",
    "token",
  );
  if (!(forbidden instanceof GitHubHttpError) || forbidden.status !== 403) {
    throw new Error("wrong error type");
  }
  if (!/The token needs Pull requests: Read\./.test(forbidden.message)) {
    throw new Error(forbidden.message);
  }
  const missing = await httpError(
    new Response("nope", { status: 404 }),
    "GET",
    "repos/o/r/pulls/4",
    "token",
  );
  if (!/may not exist or the token cannot see it/.test(missing.message)) {
    throw new Error(missing.message);
  }
  const broken = await httpError(
    new Response("boom", { status: 500 }),
    "GET",
    "repos/o/r",
    "token",
  );
  if (broken.message !== "GitHub API 500: boom")
    throw new Error(broken.message);
});

test("the generated tables list every permission with its access", () => {
  const app = permissionTable("app");
  for (const row of [
    "| Contents | Read |",
    "| Pull requests | Read and write |",
    "| Issues | Read and write |",
    "| Checks | Read and write |",
    "| Metadata | Read |",
  ]) {
    if (!app.includes(row)) throw new Error(`app table lacks ${row}\n${app}`);
  }
  const fine = permissionTable("pat-fine");
  if (/Checks/.test(fine) || /write/i.test(fine)) {
    throw new Error(`a token never writes here:\n${fine}`);
  }
  for (const row of ["| Metadata | Read |", "| Pull requests | Read |"]) {
    if (!fine.includes(row)) throw new Error(`fine table lacks ${row}`);
  }
  for (const kind of ["pat-classic", "gh", "oauth"] as const) {
    if (!permissionTable(kind).startsWith("|")) {
      throw new Error(`${kind} is not a table`);
    }
  }
});
