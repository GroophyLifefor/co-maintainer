/** What a codebase-only `init` must have done, and the numbers it is scored
 * on.
 *
 * A check is deterministic: it fails the run. A score is not: it is reported
 * and never fails. Scores measure co-maintainer, not the model, so guide
 * quality is left out on purpose. */
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Options } from "../../../types.ts";
import type { Trace } from "../trace.ts";
import type { CheckResult, Score } from "./common.ts";

export type { CheckResult, Score };

export type InitContext = {
  repo: string;
  reposDir: string;
  appDbPath: string;
  cacheDbPath: string;
  /** What `runInitOrRemake` threw, if it did. */
  error: unknown;
  trace: Trace;
  ai: "fake" | "live";
  /** The repository's files, the evidence the judge reads. */
  files: Record<string, string>;
  /** Set when every `--judge-*` flag was given. */
  judge?: { options: Options; model: string };
};

function readOutput(context: InitContext, name: string): string | undefined {
  const path = `${context.reposDir}/${context.repo}/${name}`;
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function written(context: InitContext, name: string): CheckResult {
  const text = readOutput(context, name);
  return {
    name: `${name} written`,
    ok: Boolean(text?.trim()),
    detail:
      text === undefined
        ? "missing"
        : `${Buffer.byteLength(text).toLocaleString("en-US")} bytes`,
  };
}

function builtAt(context: InitContext): string | null {
  if (!existsSync(context.appDbPath)) return null;
  const database = new DatabaseSync(context.appDbPath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT knowledge_built_at FROM repos WHERE full_name = ?")
      .get(context.repo) as { knowledge_built_at: string | null } | undefined;
    return row?.knowledge_built_at ?? null;
  } finally {
    database.close();
  }
}

/** The init-specific checks. Init's other two, "every GitHub call answered"
 * and "no call left the simulation", are inherited by every flow. */
export function initChecks(context: InitContext): CheckResult[] {
  const error = context.error;
  const built = builtAt(context);
  const guide = readOutput(context, "PR_REVIEW_GUIDE.md");
  return [
    {
      name: "init finished",
      ok: error === undefined,
      detail:
        error === undefined
          ? "no error"
          : error instanceof Error
            ? error.message
            : String(error),
    },
    written(context, "SKILL.md"),
    written(context, "CODEBASE.md"),
    {
      // A codebase-only init has no pull request reviews to learn from, and
      // the guide needs at least three review signals.
      name: "PR review guide skipped",
      ok: guide === undefined,
      detail: guide === undefined ? "no review signals" : "written anyway",
    },
    {
      name: "repository marked built in app.db",
      ok: built !== null,
      detail: built ?? "knowledge_built_at is empty",
    },
  ];
}

/** Every bullet of the written skill and codebase documents. */
function bullets(context: InitContext): string[] {
  return ["SKILL.md", "CODEBASE.md"].flatMap((name) =>
    (readOutput(context, name) ?? "")
      .split("\n")
      .map((line) => /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim())
      .filter((line): line is string => Boolean(line)),
  );
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replaceAll(/[^a-z0-9/._-]+/g, " ")
      .split(" ")
      .filter((word) => word.length > 2),
  );
}

function similar(a: Set<string>, b: Set<string>): boolean {
  const shared = [...a].filter((word) => b.has(word)).length;
  const union = new Set([...a, ...b]).size;
  return union > 0 && shared / union >= 0.8;
}

/** The share of bullets that repeat an earlier one, word for word or nearly:
 * whether deduplication did its job across both documents. */
function duplicateRatio(context: InitContext): Score {
  const lines = bullets(context);
  const seen: Set<string>[] = [];
  const repeats: string[] = [];
  for (const line of lines) {
    const set = words(line);
    if (seen.some((earlier) => similar(earlier, set))) repeats.push(line);
    seen.push(set);
  }
  return {
    name: "duplicate ratio",
    value: lines.length ? repeats.length / lines.length : null,
    detail: `${repeats.length} of ${lines.length} bullets repeat an earlier one`,
    fakeAi: context.ai === "fake",
    data: { bullets: lines.length, repeats },
  };
}

/** The product's own cost rows (`recordAiCost`), not a second count. A call
 * whose provider reported no cost makes the total unknown, never $0. */
function aiCost(context: InitContext): Score {
  const rows: {
    job: string;
    tokensIn: number;
    tokensOut: number;
    usd: number | null;
  }[] = [];
  if (existsSync(context.cacheDbPath)) {
    const database = new DatabaseSync(context.cacheDbPath, { readOnly: true });
    try {
      const values = database
        .prepare(
          "SELECT value FROM cache WHERE namespace = 'cost' AND cache_key LIKE ?",
        )
        .all(`${context.repo}:%`) as { value: string }[];
      for (const { value } of values) rows.push(JSON.parse(value));
    } finally {
      database.close();
    }
  }
  const unknown = rows.filter((row) => row.usd === null).length;
  const usd = rows.reduce((sum, row) => sum + (row.usd ?? 0), 0);
  const tokensIn = rows.reduce((sum, row) => sum + row.tokensIn, 0);
  const tokensOut = rows.reduce((sum, row) => sum + row.tokensOut, 0);
  const byJob: Record<string, number> = {};
  for (const row of rows) byJob[row.job] = (byJob[row.job] ?? 0) + 1;
  return {
    name: "AI cost and tokens",
    value: unknown ? null : usd,
    detail: `${rows.length} calls · ${tokensIn.toLocaleString("en-US")} in, ${tokensOut.toLocaleString("en-US")} out tokens · ${
      unknown ? `cost unknown for ${unknown} calls` : `$${usd.toFixed(4)}`
    }`,
    fakeAi: context.ai === "fake",
    data: {
      calls: rows.length,
      unknownCalls: unknown,
      tokensIn,
      tokensOut,
      byJob,
    },
  };
}

export type Verdict = { n: number; supported: boolean; reason?: string };

/** The judge's verdicts that can be counted: `n` names one of the claims,
 * `supported` is a boolean, and the first verdict for a claim wins. Anything
 * else is dropped, so a claim is never counted twice. */
export function judgeVerdicts(text: string, claims: number): Verdict[] {
  const match = /\{[\s\S]*\}/.exec(text);
  let parsed: unknown;
  try {
    parsed = (JSON.parse(match?.[0] ?? "{}") as { verdicts?: unknown })
      .verdicts;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<number>();
  const verdicts: Verdict[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { n, supported, reason } = item as Partial<Verdict>;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > claims ||
      typeof supported !== "boolean" ||
      seen.has(n)
    )
      continue;
    seen.add(n);
    verdicts.push({
      n,
      supported,
      ...(typeof reason === "string" ? { reason } : {}),
    });
  }
  return verdicts;
}

/** Whether each bullet says what the repository files show. The files are the
 * evidence: a fact the AI extracted from the codebase names no single file. */
async function claimEvidence(context: InitContext): Promise<Score> {
  const name = "claim-evidence agreement (LLM judge)";
  const fakeAi = context.ai === "fake";
  if (fakeAi)
    return { name, value: null, detail: "", fakeAi, skipped: "fake AI" };
  if (!context.judge) {
    return {
      name,
      value: null,
      detail: "",
      fakeAi,
      skipped: "no --judge-* flags",
    };
  }
  const lines = bullets(context);
  if (!lines.length) {
    return {
      name,
      value: null,
      detail: "",
      fakeAi,
      skipped: "no bullets written",
    };
  }
  const { createAiProvider } = await import("../../../ai/provider.ts");
  const provider = createAiProvider(context.judge.options, context.judge.model);
  if (!provider) {
    return {
      name,
      value: null,
      detail: "",
      fakeAi,
      skipped: "no judge provider",
    };
  }
  const files = Object.entries(context.files)
    .map(([path, content]) => `FILE ${path}\n${content}`)
    .join("\n\n");
  const response = await provider.complete({
    job: "sim_judge",
    maxTokens: 4_000,
    system:
      "You check claims about a repository against its files. A claim is supported only when the files directly show it.",
    prompt: `For each numbered claim, decide whether the repository files below support it.
Return only JSON: {"verdicts":[{"n":1,"supported":true,"reason":"one short sentence"}]}

CLAIMS:
${lines.map((line, index) => `${index + 1}. ${line}`).join("\n")}

FILES:
${files}`,
  });
  const verdicts = judgeVerdicts(response.text, lines.length);
  const supported = verdicts.filter((verdict) => verdict.supported).length;
  const missing = lines.length - verdicts.length;
  return {
    name,
    value: verdicts.length ? supported / lines.length : null,
    detail: verdicts.length
      ? `${supported} of ${lines.length} bullets supported${missing ? ` · ${missing} without a verdict` : ""}`
      : "the judge returned no verdicts",
    fakeAi,
    data: {
      verdicts,
      claims: lines,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      usd: response.cost ?? null,
    },
  };
}

export async function initScores(context: InitContext): Promise<Score[]> {
  let judged: Score;
  try {
    judged = await claimEvidence(context);
  } catch (error) {
    // A score never fails the run, a judge that could not answer included.
    judged = {
      name: "claim-evidence agreement (LLM judge)",
      value: null,
      detail: "",
      fakeAi: context.ai === "fake",
      skipped: `judge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return [duplicateRatio(context), aiCost(context), judged];
}
