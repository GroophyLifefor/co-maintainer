import { reviewPullRequest } from "../src/pr/reviewer.ts";
import { type ParsedFinding, parseFindings } from "../src/pr/findings.ts";
import { scopeInClone } from "../src/pr/scope.ts";
import type { Snapshot } from "../src/pr/snapshot.ts";
import type { GitHubClient, Options } from "../src/types.ts";

export type RunResult = {
  text: string;
  findings: ParsedFinding[];
  tokensIn: number;
  tokensOut: number;
  cost: number;
  costKnown: boolean;
};

/** One PR review by one tool. Everything a tool needs beyond this (a cloned
 * repo, an init'd guide, a configured provider) is preparation and happens
 * before the benchmark runs, so it stays out of the measured time. */
export type Runner = (
  client: GitHubClient,
  options: Options,
  snapshot: Snapshot,
) => Promise<RunResult>;

export const comaintainerRunner: Runner = async (client, options, snapshot) => {
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let costKnown = true;
  const response = await reviewPullRequest(
    client,
    options,
    async (usage) => {
      tokensIn += usage.tokensIn;
      tokensOut += usage.tokensOut;
      if (usage.cost === undefined) costKnown = false;
      else cost += usage.cost;
    },
    snapshot,
  );
  return {
    text: response.text,
    findings: parseFindings(response.text),
    tokensIn,
    tokensOut,
    cost,
    costKnown,
  };
};

function field(item: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const value = item[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function num(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function str(value: unknown): string {
  return value === undefined ? "" : String(value);
}

const LIST_KEYS = ["findings", "comments", "issues", "results", "reviews"];

function findingList(parsed: unknown): Record<string, unknown>[] {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): Record<string, unknown>[] => {
    if (Array.isArray(node)) {
      return node.filter((item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && !Array.isArray(item)
      );
    }
    if (!node || typeof node !== "object" || depth > 3 || seen.has(node)) {
      return [];
    }
    seen.add(node);
    const record = node as Record<string, unknown>;
    for (const key of LIST_KEYS) {
      const found = walk(record[key], depth + 1);
      if (found.length > 0) return found;
    }
    for (const value of Object.values(record)) {
      const found = walk(value, depth + 1);
      if (found.length > 0) return found;
    }
    return [];
  };
  return walk(parsed, 0);
}

/** The OCR JSON schema is not pinned by its docs, so every field is read
 * through a list of plausible names rather than one hard-coded key. A row
 * without a path and a line is not a line-anchored finding and is dropped. */
export function parseOcrFindings(raw: string): ParsedFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const findings: ParsedFinding[] = [];
  for (const item of findingList(parsed)) {
    const path = field(item, [
      "path",
      "file",
      "file_path",
      "filePath",
      "fileName",
      "filename",
    ]);
    const from = num(field(item, [
      "line",
      "start_line",
      "startLine",
      "from_line",
      "from",
      "lineStart",
      "line_start",
    ]));
    if (path === undefined || from === undefined) continue;
    const to = num(field(item, [
      "end_line",
      "endLine",
      "to_line",
      "to",
      "lineEnd",
      "line_end",
    ])) ?? from;
    const heading = str(field(item, [
      "title",
      "heading",
      "rule",
      "rule_name",
      "ruleName",
      "summary",
      "category",
    ]));
    const excerpt = str(field(item, [
      "message",
      "content",
      "body",
      "description",
      "detail",
      "comment",
      "suggestion",
    ]));
    findings.push({
      path: String(path),
      from,
      to: to < from ? from : to,
      heading: heading || excerpt.slice(0, 80),
      excerpt,
      severity: str(field(item, ["severity", "level", "priority"])) ||
        undefined,
    });
  }
  return findings;
}

export function parseOcrUsage(raw: string): {
  tokensIn: number;
  tokensOut: number;
  cost: number;
  costKnown: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { tokensIn: 0, tokensOut: 0, cost: 0, costKnown: false };
  }
  const root = (parsed ?? {}) as Record<string, unknown>;
  const usage = (field(root, [
    "usage",
    "token_usage",
    "tokenUsage",
    "stats",
    "summary",
  ]) ?? root) as Record<string, unknown>;
  const tokensIn = num(field(usage, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
    "tokens_in",
  ]));
  const tokensOut = num(field(usage, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "tokens_out",
  ]));
  const cost = num(field(usage, ["cost", "total_cost", "totalCost"]));
  return {
    tokensIn: tokensIn ?? 0,
    tokensOut: tokensOut ?? 0,
    cost: cost ?? 0,
    costKnown: cost !== undefined,
  };
}

async function run(
  cwd: string,
  bin: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const windows = Deno.build.os === "windows";
  const command = new Deno.Command(windows ? "cmd" : bin, {
    args: windows ? ["/c", bin, ...args] : args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function requireCommit(
  cloneDir: string,
  repo: string,
  sha: string,
): Promise<void> {
  // `cat-file -t` rather than `-e <sha>^{commit}`: on Windows this runs through
  // `cmd /c`, where `^` is the escape character and would silently eat the
  // peel suffix, failing the check for commits that are present.
  const check = await run(cloneDir, "git", ["cat-file", "-t", sha]);
  if (check.code === 0 && check.stdout.trim() === "commit") return;
  throw new Error(
    `${cloneDir} has no commit ${sha}. Prepare it first (not timed):\n` +
      `  git clone https://github.com/${repo} ${cloneDir}\n` +
      `  git -C ${cloneDir} fetch origin ${sha}`,
  );
}

/** Where a repo's clone lives under the clone root: one directory per repo, so
 * a dataset spanning several repos needs one root rather than one flag each. */
export function cloneDirFor(cloneRoot: string, repo: string): string {
  return `${cloneRoot}/${repo.replace("/", "-")}`;
}

/** Runs the OCR CLI over the same incremental diff co-maintainer is shown:
 * round_base_commit..round_commit. The clone and `ocr config` are preparation,
 * exactly as `init` is for co-maintainer. */
export function ocrRunner(cloneRoot: string, bin: string): Runner {
  return async (_client, options, snapshot) => {
    if (!snapshot.base) throw new Error("ocr runner needs snapshot.base");
    const cloneDir = cloneDirFor(cloneRoot, options.repo);
    try {
      await Deno.stat(`${cloneDir}/.git`);
    } catch {
      throw new Error(
        `Missing clone ${cloneDir}. Prepare it first (not timed):\n` +
          `  git clone https://github.com/${options.repo} ${cloneDir}`,
      );
    }
    await requireCommit(cloneDir, options.repo, snapshot.base);
    await requireCommit(cloneDir, options.repo, snapshot.commit);

    // Same scope co-maintainer's own reviewer applies (src/pr/scope.ts): a
    // re-review round's diff can be mostly code that arrived via a merge from
    // the default branch, not authored by this PR. Excluding it here too is
    // what makes the two tools' numbers comparable — without it, OCR is asked
    // to find bugs in code neither tool's author wrote, and co-maintainer
    // isn't, which would be the benchmark's own thumb on the scale.
    const scope = await scopeInClone(
      cloneDir,
      snapshot.base,
      snapshot.commit,
      (command, args, cwd) => run(cwd ?? cloneDir, command, args),
    );
    const exclude = scope && scope.upstreamFiles.size > 0
      ? [...scope.upstreamFiles].join(",")
      : undefined;
    if (exclude) {
      console.log(
        `  [ocr] excluding ${
          scope!.upstreamFiles.size
        } upstream file(s) from review`,
      );
    } else if (!scope) {
      console.log(
        `  [ocr] scope unavailable · reviewing every changed file`,
      );
    }

    const outFile = await Deno.makeTempFile({ suffix: ".json" });
    try {
      const result = await run(cloneDir, bin, [
        "review",
        "--from",
        snapshot.base,
        "--to",
        snapshot.commit,
        "--format",
        "json",
        "--output",
        outFile,
        ...(exclude ? ["--exclude", exclude] : []),
      ]);
      let raw = "";
      try {
        raw = await Deno.readTextFile(outFile);
      } catch {
        raw = "";
      }
      if (raw.trim() === "") raw = result.stdout;
      if (raw.trim() === "" && result.code !== 0) {
        throw new Error(
          `${bin} review exited ${result.code}: ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      return {
        text: raw,
        findings: parseOcrFindings(raw),
        ...parseOcrUsage(raw),
      };
    } finally {
      await Deno.remove(outFile).catch(() => {});
    }
  };
}
