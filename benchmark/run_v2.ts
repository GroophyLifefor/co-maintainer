import { parseArgs } from "../src/cli/args.ts";
import { GhClient } from "../src/data/gh.ts";
import { reviewPullRequest } from "../src/review.ts";
import { average, scores } from "./metrics.ts";
import { matchPairs, matchSpans } from "./match.ts";
import { parseFindings } from "./parse.ts";
import { judgeMatches } from "./judge.ts";

type Row = {
  pr: number;
  path: string;
  from_line: number;
  to_line: number;
  side: string;
  quote: string;
  why: string;
  ref_commit: string;
  ref_before: string;
};

function flag(args: string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(
    name.length + 3,
  );
}

function intFlag(args: string[], name: string, fallback: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be an integer >= 1`);
  }
  return value;
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
}

const args = Deno.args.filter((arg) => arg !== "--");
const repo = flag(args, "repo") ?? "nodejs/undici";
const datasetPath = flag(args, "dataset") ?? "benchmark/benchv2_dataset.json";
const reviewConcurrent = intFlag(args, "review-concurrent", 1);
const judgeModel = flag(args, "judge-model") ?? "openai/gpt-oss-120b";
const reviewFlags = args.filter((arg) =>
  !arg.startsWith("--repo=") &&
  !arg.startsWith("--dataset=") &&
  !arg.startsWith("--review-concurrent=") &&
  !arg.startsWith("--judge-model=")
);

let dataset: Row[];
try {
  dataset = JSON.parse(await Deno.readTextFile(datasetPath)) as Row[];
} catch (error) {
  if (error instanceof Deno.errors.NotFound) {
    throw new Error(`Missing ${datasetPath}; generate the gold set first`);
  }
  throw error;
}
if (dataset.length === 0) throw new Error(`Empty dataset ${datasetPath}`);

try {
  await Deno.stat(`repos/${repo}/PR_REVIEW_GUIDE.md`);
} catch {
  throw new Error(
    `Missing repos/${repo}/PR_REVIEW_GUIDE.md. Init first (not timed):\n  deno task init ${repo} --max-pr-months=3 --log-time --env=.env`,
  );
}

const byPr = new Map<number, Row[]>();
for (const row of dataset) {
  const list = byPr.get(row.pr) ?? [];
  list.push(row);
  byPr.set(row.pr, list);
}
const client = new GhClient();
const reports: {
  pr: number;
  gold: number;
  predicted: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  tokens: number;
  cost: number;
  costKnown: boolean;
}[] = [];
const details: {
  pr: number;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  tokens: number;
  cost: number;
  costKnown: boolean;
  review: string;
  predicted: ReturnType<typeof parseFindings>;
  gold: { path: string; from: number; to: number; quote: string; why: string }[];
  pairs: { predicted: number; gold: number }[];
  unmatchedPredicted: number[];
  unmatchedGold: number[];
}[] = [];

const jobs = [...byPr.entries()];
console.log(
  `[bench-v2] ${jobs.length} PRs in ${repo} · review-concurrent=${reviewConcurrent}`,
);
const baseOptions = parseArgs([
  "review",
  repo,
  String(jobs[0][0]),
  ...reviewFlags,
]);

await mapPool(jobs, reviewConcurrent, async ([number, rows]) => {
  const gold = rows.map((row) => ({
    path: row.path,
    from: row.from_line,
    to: row.to_line,
    quote: row.quote,
    why: row.why,
  }));
  const options = { ...baseOptions, prNumber: number };
  const snapshot = { commit: rows[0].ref_commit, before: rows[0].ref_before };
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let costKnown = true;
  const started = performance.now();
  let response;
  try {
    response = await reviewPullRequest(
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
  } catch (error) {
    const ms = performance.now() - started;
    console.log(`#${number}  FAILED  ${String(error)}`);
    reports.push({
      pr: number,
      gold: gold.length,
      predicted: 0,
      tp: 0,
      fp: 0,
      fn: gold.length,
      precision: 0,
      recall: 0,
      f1: 0,
      ms,
      tokensIn,
      tokensOut,
      tokens: tokensIn + tokensOut,
      cost,
      costKnown,
    });
    details.push({
      pr: number,
      ms,
      tokensIn,
      tokensOut,
      tokens: tokensIn + tokensOut,
      cost,
      costKnown,
      review: `ERROR: ${String(error)}`,
      predicted: [],
      gold,
      pairs: [],
      unmatchedPredicted: [],
      unmatchedGold: gold.map((_, i) => i),
    });
    return;
  }
  const ms = performance.now() - started;
  const predicted = parseFindings(response.text);
  const pairs = matchPairs(predicted, gold);
  const matchedPredicted = new Set(pairs.map((pair) => pair.predicted));
  const matchedGold = new Set(pairs.map((pair) => pair.gold));

  // Same defect, different anchor line/file (model points at the fix site,
  // the human reviewer at the triggering line) — ask a judge model before
  // scoring the leftovers as pure misses.
  const leftoverPredicted = predicted.map((_, i) => i).filter((i) =>
    !matchedPredicted.has(i)
  );
  const leftoverGold = gold.map((_, i) => i).filter((i) => !matchedGold.has(i));
  if (options.aiToken) {
    const semanticPairs = await judgeMatches(
      options.aiToken,
      judgeModel,
      predicted,
      gold,
      leftoverPredicted,
      leftoverGold,
      async (usage) => {
        tokensIn += usage.tokensIn;
        tokensOut += usage.tokensOut;
        if (usage.cost === undefined) costKnown = false;
        else cost += usage.cost;
      },
    );
    for (const pair of semanticPairs) {
      pairs.push(pair);
      matchedPredicted.add(pair.predicted);
      matchedGold.add(pair.gold);
    }
  }
  const counts = matchSpans(predicted, gold, pairs);
  const scored = scores(counts);
  const tokens = tokensIn + tokensOut;
  reports.push({
    pr: number,
    gold: gold.length,
    predicted: predicted.length,
    ...counts,
    ...scored,
    ms,
    tokensIn,
    tokensOut,
    tokens,
    cost,
    costKnown,
  });
  details.push({
    pr: number,
    ms,
    tokensIn,
    tokensOut,
    tokens,
    cost,
    costKnown,
    review: response.text,
    predicted,
    gold,
    pairs,
    unmatchedPredicted: predicted.map((_, i) => i).filter((i) =>
      !matchedPredicted.has(i)
    ),
    unmatchedGold: gold.map((_, i) => i).filter((i) => !matchedGold.has(i)),
  });
  console.log(
    `#${number}  tp=${counts.tp} fp=${counts.fp} fn=${counts.fn}  predicted=${predicted.length}/${gold.length} gold  ${
      (ms / 1000).toFixed(1)
    }s  in=${tokensIn} out=${tokensOut} total=${tokens} tok  $${
      costKnown ? cost.toFixed(4) : "unknown"
    }`,
  );
});
reports.sort((a, b) => a.pr - b.pr);

const totals = reports.reduce(
  (sum, row) => ({
    tp: sum.tp + row.tp,
    fp: sum.fp + row.fp,
    fn: sum.fn + row.fn,
  }),
  { tp: 0, fp: 0, fn: 0 },
);
const costKnown = reports.every((row) => row.costKnown);
const totalCost = reports.reduce((sum, row) => sum + row.cost, 0);
const { f1, precision, recall } = scores(totals);
const result = {
  repo,
  gold: "benchmark v2 — real human reviewer comments, pinned to the diff/discussion state as of the first review",
  prs: reports.length,
  f1,
  precision,
  recall,
  avgTimeMs: average(reports.map((row) => row.ms)),
  avgTokensIn: average(reports.map((row) => row.tokensIn)),
  avgTokensOut: average(reports.map((row) => row.tokensOut)),
  avgTokens: average(reports.map((row) => row.tokens)),
  avgCost: average(reports.map((row) => row.cost)),
  totalCost,
  costKnown,
  reports,
};

console.log(
  `\n${repo}  PRs=${result.prs}  F1=${f1.toFixed(3)}  P=${
    precision.toFixed(3)
  }  R=${recall.toFixed(3)}  avgTime=${
    (result.avgTimeMs / 1000).toFixed(1)
  }s  avgTok(in/out/total)=${result.avgTokensIn.toFixed(0)}/${
    result.avgTokensOut.toFixed(0)
  }/${result.avgTokens.toFixed(0)}  avgCost=$${
    costKnown ? result.avgCost.toFixed(4) : "unknown"
  }  totalCost=$${costKnown ? totalCost.toFixed(4) : "unknown"}`,
);

await Deno.mkdir("benchmark/results", { recursive: true });
const slug = `${repo.replace("/", "-")}-v2`;
const out = `benchmark/results/${slug}.json`;
await Deno.writeTextFile(out, `${JSON.stringify(result, null, 2)}\n`);
details.sort((a, b) => a.pr - b.pr);
const detailDir = `benchmark/results/${slug}`;
await Deno.mkdir(detailDir, { recursive: true });
await Deno.writeTextFile(
  `${detailDir}/detail.json`,
  `${JSON.stringify({ repo, ...scores(totals), details }, null, 2)}\n`,
);
for (const item of details) {
  await Deno.writeTextFile(`${detailDir}/${item.pr}.md`, item.review);
}
console.log(`wrote ${out}`);
console.log(
  `wrote ${detailDir}/detail.json and ${details.length} review .md files`,
);
