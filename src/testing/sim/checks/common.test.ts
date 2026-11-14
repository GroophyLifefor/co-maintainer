/** Each inherited check passes on a clean trace and fails when its rule is
 * broken. The traces are built by hand, so one test breaks one rule. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { SimGithub } from "../github.ts";
import { type Completion, Trace } from "../trace.ts";
import type { World } from "../world.ts";
import { type CommonInput, commonChecks, commonScores } from "./common.ts";

const dir = mkdtempSync(join(tmpdir(), "cm-sim-checks-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const SECRET = "sim-pat-0123456789abcdef";
let dbs = 0;

/** A cache.db with these cost rows. */
function cacheDb(rows: { tokensIn: number; tokensOut: number }[]): string {
  const path = join(dir, `cache-${dbs++}.db`);
  const database = new DatabaseSync(path);
  database.exec(
    "CREATE TABLE cache (namespace TEXT, cache_key TEXT, value TEXT, updated_at TEXT)",
  );
  rows.forEach((row, index) =>
    database
      .prepare("INSERT INTO cache VALUES ('cost', ?, ?, '')")
      .run(`r:${index}`, JSON.stringify(row)),
  );
  database.close();
  return path;
}

/** A call that answered: what it billed is what the product got. */
function completion(patch: Partial<Completion> = {}): Completion {
  const tokensIn = patch.tokensIn ?? 10;
  const tokensOut = patch.tokensOut ?? 2;
  return {
    step: "s",
    startMs: 0,
    job: "review_pull_request",
    ok: true,
    system: "be careful",
    firstUser: "review this",
    tokensIn,
    tokensOut,
    billedIn: tokensIn,
    billedOut: tokensOut,
    cost: 0,
    toolCalls: 0,
    toolCallIds: [],
    answers: [],
    ...patch,
  };
}

function input(patch: Partial<CommonInput> = {}): CommonInput {
  const trace = patch.trace ?? new Trace(performance.now());
  return {
    trace,
    mode: "fake",
    github: new SimGithub({ repos: new Map() } as unknown as World),
    secrets: [
      { name: "GitHub token", value: SECRET, hosts: ["api.github.com"] },
    ],
    files: [],
    appDbPath: join(dir, "missing-app.db"),
    cacheDbPath: cacheDb([]),
    unusedFaults: [],
    unusedRules: [],
    ...patch,
  };
}

function result(name: string, value: CommonInput) {
  const found = commonChecks(value).find((check) => check.name === name);
  assert.ok(found, name);
  return found;
}

test("a clean trace passes every inherited check", () => {
  const checks = commonChecks(input());
  assert.deepEqual(
    checks.filter((check) => !check.ok),
    [],
  );
  assert.equal(checks.length, 8);
});

test("a call that left the simulation fails", () => {
  const trace = new Trace(0);
  trace.leaks.push({ step: "s", startMs: 0, method: "GET", url: "https://x" });
  assert.equal(
    result("no call left the simulation", input({ trace })).ok,
    false,
  );
});

test("a GitHub call with no route fails", () => {
  const trace = new Trace(0);
  trace.github.push({
    step: "s",
    startMs: 0,
    method: "GET",
    url: "https://api.github.com/repos/o/r/deployments",
    status: 404,
    ms: 0,
    request: null,
    response: null,
    handled: false,
    via: "fetch",
  });
  const check = result("every GitHub call answered", input({ trace }));
  assert.equal(check.ok, false);
  assert.match(check.detail, /deployments/);
});

test("an unscripted AI call fails, and a live run skips the check", () => {
  const trace = new Trace(0);
  trace.ai.push({
    step: "s",
    startMs: 0,
    method: "POST",
    url: "https://openrouter.ai/api/v1/chat/completions",
    status: 500,
    ms: 0,
    request: null,
    response: null,
    mode: "fake",
    job: "new_job",
    unscripted: true,
  });
  assert.equal(result("every AI call scripted", input({ trace })).ok, false);
  const live = result("every AI call scripted", input({ trace, mode: "live" }));
  assert.equal(live.skipped, "live AI");
});

test("a secret in a log line, a posted comment or a written file fails", () => {
  const name = "no secret in the trace, logs, files or GitHub";
  const logged = new Trace(0);
  logged.log("fetch", `token ${SECRET}`);
  const inLog = result(name, input({ trace: logged }));
  assert.equal(inLog.ok, false);
  assert.match(inLog.detail, /GitHub token in logs/);
  assert.ok(!inLog.detail.includes(SECRET), "the detail names, never shows");

  const value = input();
  value.github.comments.push({
    id: 1,
    repo: "o/r",
    number: 1,
    kind: "issue",
    body: `oops ${SECRET}`,
    user: { login: "bot", type: "Bot" },
    association: "NONE",
    createdAt: "",
    updatedAt: "",
  });
  assert.match(result(name, value).detail, /posted to GitHub/);

  const printed = new Trace(0);
  printed.cli.push({
    step: "s",
    startMs: 0,
    args: ["review"],
    stdout: `token=${encodeURIComponent(SECRET)}`,
    stderr: "",
    exitCode: 0,
  });
  assert.match(result(name, input({ trace: printed })).detail, /CLI output/);

  const inFile = result(
    name,
    input({ files: [{ path: "o/r/SKILL.md", bytes: 1, content: SECRET }] }),
  );
  assert.match(inFile.detail, /file o\/r\/SKILL.md/);
});

test("AI usage missing from the cost records fails", () => {
  const name = "cost recorded for every AI call";
  const trace = new Trace(0);
  trace.completions.push(completion(), completion({ tokensIn: 5 }));
  const missing = result(name, input({ trace, cacheDbPath: cacheDb([]) }));
  assert.equal(missing.ok, false);
  const partial = result(
    name,
    input({ trace, cacheDbPath: cacheDb([{ tokensIn: 10, tokensOut: 2 }]) }),
  );
  assert.equal(partial.ok, false);
  // One merged row for both calls, as a tool loop records it, is complete.
  const merged = result(
    name,
    input({ trace, cacheDbPath: cacheDb([{ tokensIn: 15, tokensOut: 4 }]) }),
  );
  assert.equal(merged.ok, true);
});

test("a call the product threw on after the provider billed it still counts", () => {
  const trace = new Trace(0);
  trace.completions.push(
    completion(),
    completion({
      ok: false,
      tokensIn: 0,
      tokensOut: 0,
      billedIn: 7,
      billedOut: 3,
    }),
  );
  const check = result(
    "cost recorded for every AI call",
    input({ trace, cacheDbPath: cacheDb([{ tokensIn: 10, tokensOut: 2 }]) }),
  );
  assert.equal(check.ok, false);
  assert.match(check.detail, /totals compared/);
  assert.match(check.detail, /1 of them threw/);
});

test("the judge's own calls are not the product's to record", () => {
  const trace = new Trace(0);
  trace.completions.push(completion({ job: "sim_judge" }));
  assert.equal(
    result("cost recorded for every AI call", input({ trace })).ok,
    true,
  );
});

test("a system prompt that changes between rounds fails", () => {
  const name = "one system prompt per conversation";
  const trace = new Trace(0);
  trace.completions.push(
    completion({ toolCalls: 1 }),
    completion({ system: "be careful, round 2" }),
  );
  const check = result(name, input({ trace }));
  assert.equal(check.ok, false);
  assert.match(
    check.detail,
    /review_pull_request: 2 system prompts over 2 rounds/,
  );
  // A round that changes its system prompt and its first message is still
  // tied to the round whose tool calls it answers.
  const both = new Trace(0);
  both.completions.push(
    completion({ toolCalls: 1, toolCallIds: ["call_9"] }),
    completion({ system: "new", firstUser: "new", answers: ["call_9"] }),
  );
  assert.equal(result(name, input({ trace: both })).ok, false);
  // Another conversation may have its own system prompt.
  const other = new Trace(0);
  other.completions.push(
    completion(),
    completion({ firstUser: "another pull request", system: "different" }),
  );
  assert.equal(result(name, input({ trace: other })).ok, true);
});

test("an AI rule that answered nothing fails, and a live run skips the check", () => {
  const check = result(
    "every AI rule answered",
    input({ unusedRules: ["second round"] }),
  );
  assert.equal(check.ok, false);
  assert.match(check.detail, /second round/);
  const live = result(
    "every AI rule answered",
    input({ unusedRules: ["second round"], mode: "live" }),
  );
  assert.equal(live.skipped, "live AI");
});

test("a planned fault that never happened fails", () => {
  const check = result(
    "every planned fault happened",
    input({ unusedFaults: [{ target: "github", kind: "500", path: "/x" }] }),
  );
  assert.equal(check.ok, false);
  assert.match(check.detail, /github 500 on \/x/);
});

test("scores count calls, tokens, cost and tool rounds per job", () => {
  const trace = new Trace(0);
  trace.completions.push(
    completion({ toolCalls: 2 }),
    completion({ cost: null }),
    completion({ job: "synth_section" }),
    completion({ job: "sim_judge" }),
  );
  const scores = Object.fromEntries(
    commonScores(trace, "fake").map((score) => [score.name, score]),
  );
  assert.equal(scores["AI calls"]!.value, 3);
  assert.equal(scores["AI tokens"]!.value, 36);
  assert.equal(scores["AI cost"]!.value, null, "one unknown cost is unknown");
  assert.equal(scores["tool rounds per job"]!.value, 1);
  assert.ok(Object.values(scores).every((score) => score.fakeAi));
});
