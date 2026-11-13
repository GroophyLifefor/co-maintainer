/** The checks and scores every flow gets without writing them.
 *
 * They hold for any flow: nothing leaves the simulation, every GitHub and AI
 * call was expected, no secret ends up anywhere a person could read it, every
 * AI call's usage reached the product's cost records, and a conversation
 * keeps one system prompt. A flow can turn one off with a reason
 * (`skipInherited`), which the report shows. */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Fault } from "../faults.ts";
import { describeFault } from "../faults.ts";
import type { SimGithub } from "../github.ts";
import {
  type Completion,
  dumpDatabase,
  type FileEntry,
  NOT_SEARCHED,
  type Trace,
} from "../trace.ts";
import type { Secret } from "../world.ts";

export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
  /** Why the check was not run. A skipped check never fails the run. */
  skipped?: string;
};

export type Score = {
  name: string;
  value: number | null;
  detail: string;
  /** Computed on the fake AI's answers: kept in the report, but it measures
   * nothing. */
  fakeAi: boolean;
  /** Why the score was not computed. */
  skipped?: string;
  data?: Record<string, unknown>;
};

/** What the inherited checks look at. */
export type CommonInput = {
  trace: Trace;
  mode: "fake" | "live";
  github: SimGithub;
  secrets: Secret[];
  /** Every file in the sandbox a leak could land in (`readSandbox`). */
  files: FileEntry[];
  appDbPath: string;
  cacheDbPath: string;
  unusedFaults: Fault[];
  /** Fake AI rules that answered nothing and are not `optional`, by name. */
  unusedRules: string[];
};

export const INHERITED_CHECKS = [
  "no call left the simulation",
  "every GitHub call answered",
  "every AI call scripted",
  "no secret in the trace, logs, files or GitHub",
  "cost recorded for every AI call",
  "one system prompt per conversation",
  "every planned fault happened",
  "every AI rule answered",
] as const;

export type InheritedCheck = (typeof INHERITED_CHECKS)[number];

/** AI calls the product made. The simulation's own (the judge, `sim_*`) are
 * not the product's to record. */
export function productCompletions(trace: Trace): Completion[] {
  return trace.completions.filter(
    (completion) => !completion.job.startsWith("sim_"),
  );
}

function readRows<T>(path: string, sql: string): T[] {
  if (!existsSync(path)) return [];
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(sql).all() as T[];
  } catch {
    // A table that does not exist yet has no rows.
    return [];
  } finally {
    database.close();
  }
}

/** The base64 of `value` wherever it starts in a longer encoded text. Base64
 * packs 3 bytes into 4 characters, so the secret's characters depend on its
 * offset: each of the three offsets gives the run of characters that only the
 * secret decides. */
function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value);
  const forms: string[] = [];
  for (let pad = 0; pad < 3; pad++) {
    const encoded = Buffer.concat([Buffer.alloc(pad), bytes]).toString(
      "base64",
    );
    const start = [0, 2, 3][pad]!;
    const end = Math.floor((pad + bytes.length) / 3) * 4;
    const form = encoded.slice(start, end);
    forms.push(form, form.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return forms;
}

/** Every way a secret is searched for: as is, URL encoded, and base64 at
 * each offset. Forms too short to mean anything are left out. */
export function secretForms(value: string): string[] {
  return [
    ...new Set([value, encodeURIComponent(value), ...base64Forms(value)]),
  ].filter((form) => form.length >= 8);
}

/** A text with its whitespace, and the escapes JSON writes for it, taken
 * out, so a secret split across lines is still one string. */
function squeezed(text: string): string {
  return text.replaceAll(/\\[nrt]|\s+/g, "");
}

function leakCheck(input: CommonInput): CheckResult {
  const { trace, github } = input;
  const places: [string, string][] = [
    ["GitHub calls", JSON.stringify(trace.github)],
    ["AI calls", JSON.stringify(trace.ai)],
    ["provider calls", JSON.stringify(trace.completions)],
    ["remote calls", JSON.stringify(trace.remote)],
    ["webhooks", JSON.stringify(trace.webhooks)],
    ["logs", JSON.stringify(trace.logs)],
    ["CLI output", JSON.stringify(trace.cli)],
    ["app.db", JSON.stringify(dumpDatabase(input.appDbPath))],
    ["cache.db", JSON.stringify(dumpDatabase(input.cacheDbPath))],
    [
      "posted to GitHub",
      JSON.stringify([
        github.writes,
        github.comments,
        github.reviews,
        github.checkRuns,
        github.issues,
      ]),
    ],
    ...input.files.map(
      (file) => [`file ${file.path}`, file.content] as [string, string],
    ),
  ];
  const found: string[] = [];
  const searched = places.map(
    ([place, text]) => [place, text, squeezed(text)] as const,
  );
  for (const secret of input.secrets) {
    const forms = secretForms(secret.value);
    for (const [place, text, flat] of searched) {
      if (forms.some((form) => text.includes(form) || flat.includes(form))) {
        found.push(`${secret.name} in ${place}`);
      }
    }
  }
  // A secret in a request header may only go to its own hosts: the GitHub
  // token to GitHub, the AI key to the AI provider.
  const allowed = new Map(input.secrets.map((s) => [s.name, s.hosts]));
  for (const use of trace.credentials) {
    if (!(allowed.get(use.secret) ?? []).includes(use.host)) {
      found.push(`${use.secret} sent to ${use.host}`);
    }
  }
  const unique = [...new Set(found)];
  return {
    name: "no secret in the trace, logs, files or GitHub",
    ok: unique.length === 0,
    detail: unique.length
      ? unique.join(", ")
      : `${input.secrets.length} secrets, ${places.length} places, ${trace.credentials.length} requests with a credential · not searched: ${NOT_SEARCHED.join(", ")}`,
  };
}

/** The usage every AI call reported must be in the product's own records:
 * the cost rows in cache.db (`recordAiCost`), plus the reviews table for a
 * review the server ran, which keeps one total per review. A call whose
 * tokens are in neither was not recorded. */
function costCheck(input: CommonInput): CheckResult {
  const name = "cost recorded for every AI call";
  const calls = productCompletions(input.trace).filter((call) => call.ok);
  const reported = {
    in: calls.reduce((sum, call) => sum + call.tokensIn, 0),
    out: calls.reduce((sum, call) => sum + call.tokensOut, 0),
  };
  if (!calls.length) return { name, ok: true, detail: "no AI calls" };
  const rows = readRows<{ value: string }>(
    input.cacheDbPath,
    "SELECT value FROM cache WHERE namespace = 'cost'",
  ).map(
    (row) => JSON.parse(row.value) as { tokensIn: number; tokensOut: number },
  );
  const cost = {
    in: rows.reduce((sum, row) => sum + row.tokensIn, 0),
    out: rows.reduce((sum, row) => sum + row.tokensOut, 0),
  };
  const reviews = readRows<{ tokens_in: number; tokens_out: number }>(
    input.appDbPath,
    "SELECT tokens_in, tokens_out FROM reviews",
  );
  const review = {
    in: reviews.reduce((sum, row) => sum + row.tokens_in, 0),
    out: reviews.reduce((sum, row) => sum + row.tokens_out, 0),
  };
  const same = (a: typeof reported) =>
    a.in === reported.in && a.out === reported.out;
  const ok =
    same(cost) || same({ in: cost.in + review.in, out: cost.out + review.out });
  return {
    name,
    ok,
    detail: `${calls.length} calls reported ${reported.in} in, ${reported.out} out · ${rows.length} cost rows hold ${cost.in} in, ${cost.out} out${
      reviews.length
        ? ` · ${reviews.length} reviews hold ${review.in} in, ${review.out} out`
        : ""
    }`,
  };
}

/** A conversation is one job and one first user message: every tool round
 * resends both. Its system prompt must not change between rounds, or a
 * provider's prompt cache misses on every round. */
function systemPromptCheck(input: CommonInput): CheckResult {
  const groups = new Map<string, Set<string>>();
  const rounds = new Map<string, number>();
  for (const call of productCompletions(input.trace)) {
    const key = `${call.job}\u0000${call.firstUser}`;
    const set = groups.get(key) ?? new Set<string>();
    set.add(call.system);
    groups.set(key, set);
    rounds.set(key, (rounds.get(key) ?? 0) + 1);
  }
  const changed = [...groups.entries()].filter(([, set]) => set.size > 1);
  const multi = [...rounds.values()].filter((count) => count > 1).length;
  return {
    name: "one system prompt per conversation",
    ok: changed.length === 0,
    detail: changed.length
      ? changed
          .map(
            ([key, set]) =>
              `${key.split("\u0000")[0]}: ${set.size} system prompts over ${rounds.get(key)} rounds`,
          )
          .join(", ")
      : `${groups.size} conversations, ${multi} with more than one round`,
  };
}

export function commonChecks(input: CommonInput): CheckResult[] {
  const { trace } = input;
  const unhandled = trace.github.filter((call) => !call.handled);
  const unscripted = trace.ai.filter((call) => call.unscripted);
  return [
    {
      name: "no call left the simulation",
      ok: trace.leaks.length === 0,
      detail: trace.leaks.length
        ? trace.leaks.map((leak) => `${leak.method} ${leak.url}`).join(", ")
        : "none",
    },
    {
      name: "every GitHub call answered",
      ok: unhandled.length === 0,
      detail: unhandled.length
        ? unhandled.map((call) => `${call.method} ${call.url}`).join(", ")
        : `${trace.github.length} calls`,
    },
    input.mode === "live"
      ? {
          name: "every AI call scripted",
          ok: true,
          detail: "",
          skipped: "live AI",
        }
      : {
          name: "every AI call scripted",
          ok: unscripted.length === 0,
          detail: unscripted.length
            ? unscripted
                .map((call) => `job ${call.job ?? "(unknown)"}`)
                .join(", ")
            : `${trace.ai.length} calls`,
        },
    leakCheck(input),
    costCheck(input),
    systemPromptCheck(input),
    {
      name: "every planned fault happened",
      ok: input.unusedFaults.length === 0,
      detail: input.unusedFaults.length
        ? input.unusedFaults.map(describeFault).join(", ")
        : "none left",
    },
    // A rule nothing reached means the flow never tested what it scripted.
    input.mode === "live"
      ? {
          name: "every AI rule answered",
          ok: true,
          detail: "",
          skipped: "live AI",
        }
      : {
          name: "every AI rule answered",
          ok: input.unusedRules.length === 0,
          detail: input.unusedRules.length
            ? input.unusedRules
                .map((rule) => rule || "(unnamed rule)")
                .join(", ")
            : "all answered or optional",
        },
  ];
}

function byJob(calls: Completion[]) {
  const jobs: Record<
    string,
    {
      calls: number;
      tokensIn: number;
      tokensOut: number;
      toolRounds: number;
      failed: number;
    }
  > = {};
  for (const call of calls) {
    const row = (jobs[call.job] ??= {
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      toolRounds: 0,
      failed: 0,
    });
    row.calls++;
    row.tokensIn += call.tokensIn;
    row.tokensOut += call.tokensOut;
    if (call.toolCalls > 0) row.toolRounds++;
    if (!call.ok) row.failed++;
  }
  return jobs;
}

/** AI calls, tokens, cost and tool rounds, per job. Counted from what each
 * `complete()` returned, so they read the same for every provider. */
export function commonScores(trace: Trace, mode: "fake" | "live"): Score[] {
  const calls = productCompletions(trace);
  const jobs = byJob(calls);
  const fakeAi = mode === "fake";
  const tokensIn = calls.reduce((sum, call) => sum + call.tokensIn, 0);
  const tokensOut = calls.reduce((sum, call) => sum + call.tokensOut, 0);
  const answered = calls.filter((call) => call.ok);
  const unknown = answered.filter((call) => call.cost === null).length;
  const usd = answered.reduce((sum, call) => sum + (call.cost ?? 0), 0);
  const toolRounds = calls.filter((call) => call.toolCalls > 0).length;
  const list = (pick: (row: (typeof jobs)[string]) => number) =>
    Object.entries(jobs)
      .map(([job, row]) => `${job} ${pick(row)}`)
      .join(", ") || "none";
  return [
    {
      name: "AI calls",
      value: calls.length,
      detail: list((row) => row.calls),
      fakeAi,
      data: { byJob: jobs },
    },
    {
      name: "AI tokens",
      value: tokensIn + tokensOut,
      detail: `${tokensIn.toLocaleString("en-US")} in, ${tokensOut.toLocaleString("en-US")} out`,
      fakeAi,
      data: { tokensIn, tokensOut },
    },
    {
      name: "AI cost",
      value: unknown ? null : usd,
      detail: unknown
        ? `unknown for ${unknown} of ${answered.length} calls`
        : `$${usd.toFixed(4)} over ${answered.length} calls`,
      fakeAi,
      data: { usd, unknownCalls: unknown },
    },
    {
      name: "tool rounds per job",
      value: toolRounds,
      detail: list((row) => row.toolRounds),
      fakeAi,
      data: {
        byJob: Object.fromEntries(
          Object.entries(jobs).map(([job, row]) => [job, row.toolRounds]),
        ),
      },
    },
  ];
}
