// Fake `gh` for the CLI harness (CORE-03).
//
// Invoked through `CM_GH_BIN` as `gh api <endpoint>`. Reads fixtures from
// `gh_fixture.json` next to this file, appends each call to the file named by
// `CM_FAKE_GH_LOG`, and fails according to `CM_FAKE_GH_MODE` so the CLI's
// error paths can be exercised without a network or a real token.
//
// Plain .mjs, not .ts: this runs as its own process through `node`, so it must
// not depend on the type-stripping loader.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, "gh_fixture.json"), "utf8"),
);
const mode = process.env.CM_FAKE_GH_MODE ?? "ok";

/** The endpoint is the only positional after `api`: skip flags and the values
 * that `-X` and `--input` consume. */
function endpointFrom(args) {
  const rest = args[0] === "api" ? args.slice(1) : args;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "-X" || arg === "--input") {
      index++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return "";
}

const args = process.argv.slice(2);
const endpoint = endpointFrom(args);

if (process.env.CM_FAKE_GH_LOG) {
  appendFileSync(process.env.CM_FAKE_GH_LOG, `${args.join(" ")}\n`);
}

function fail(message, code) {
  if (message) process.stderr.write(`${message}\n`);
  process.exit(code);
}

if (mode === "notfound") fail("gh: Not Found (HTTP 404)", 1);
if (mode === "forbidden") fail("gh: Resource not accessible (HTTP 403)", 1);
if (mode === "noauth") {
  fail(
    "gh: To get started with GitHub CLI, please run: gh auth login\n" +
      "Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.",
    1,
  );
}
if (mode === "empty-stderr") fail("", 1);

/** Fixture keys are regex sources tried in order against the endpoint, so one
 * entry can cover a paginated family such as `repos/o/r/pulls?...`. A body of
 * `"@name"` (or an array containing one) is resolved against the top-level
 * fixture object, which keeps the sample data defined once. */
function resolve(value) {
  if (typeof value === "string" && value.startsWith("@")) {
    return fixtures[value.slice(1)];
  }
  if (Array.isArray(value)) return value.map(resolve);
  return value;
}

function respond() {
  for (const entry of fixtures.routes) {
    if (new RegExp(entry.match).test(endpoint)) {
      return resolve(entry.body);
    }
  }
  return undefined;
}

const body = respond();
if (body === undefined) {
  fail(`gh: Not Found (HTTP 404)`, 1);
}
process.stdout.write(`${JSON.stringify(body)}\n`);
