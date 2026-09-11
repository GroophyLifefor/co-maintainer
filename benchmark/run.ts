import { parseArgs } from "../src/cli/args.ts";
import { reposDir } from "../src/config.ts";
import { GhClient } from "../src/github/gh.ts";
import { reviewPullRequest } from "../src/pr/reviewer.ts";
import { average, scores } from "./metrics.ts";
import { matchPairs, matchSpans } from "./match.ts";
import { parseFindings } from "../src/pr/findings.ts";

type Row = {
  pr_url: string;
  path: string;
  from_line: number;
  to_line: number;
  label: number;
  note?: string;
  category?: string;
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
    Array.from(
      { length: Math.min(concurrency, items.length) },
      worker,
    ),
  );
}

function prNumber(url: string): number {
  const match = url.match(/\/pull\/(\d+)/);
  if (!match) throw new Error(`No PR number in ${url}`);
  return Number(match[1]);
}

const args = Deno.args.filter((arg) => arg !== "--");
const repo = flag(args, "repo") ?? "mrdoob/three.js";
const datasetPath = flag(args, "dataset") ?? "benchmark/dataset.json";
const reviewConcurrent = intFlag(args, "review-concurrent", 1);
const reviewFlags = args.filter((arg) =>
  !arg.startsWith("--repo=") &&
  !arg.startsWith("--dataset=") &&
  !arg.startsWith("--review-concurrent=")
);

let dataset: Row[];
try {
  dataset = JSON.parse(await Deno.readTextFile(datasetPath)) as Row[];
} catch (error) {
  if (error instanceof Deno.errors.NotFound) {
    throw new Error(`Missing ${datasetPath}; download AACR-Bench there first`);
  }
  throw error;
}

const rows = dataset.filter((row) =>
  row.pr_url.includes(`github.com/${repo}/pull/`)
);
if (rows.length === 0) throw new Error(`No AACR comments for ${repo}`);

try {
  await Deno.stat(`${reposDir()}/${repo}/PR_REVIEW_GUIDE.md`);
} catch {
  throw new Error(
    `Missing ${reposDir()}/${repo}/PR_REVIEW_GUIDE.md. Init first (not timed):\n  deno task init ${repo} --max-pr-months=3 --log-time --env=.env`,
  );
}

const byPr = new Map<number, Row[]>();
for (const row of rows) {
  const number = prNumber(row.pr_url);
  const list = byPr.get(number) ?? [];
  list.push(row);
  byPr.set(number, list);
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
  tokens: number;
  cost: number;
  costKnown: boolean;
}[] = [];
const details: {
  pr: number;
  ms: number;
  tokens: number;
  cost: number;
  costKnown: boolean;
  review: string;
  predicted: ReturnType<typeof parseFindings>;
  gold: {
    path: string;
    from: number;
    to: number;
    category?: string;
    note?: string;
  }[];
  pairs: { predicted: number; gold: number }[];
  unmatchedPredicted: number[];
  unmatchedGold: number[];
}[] = [];

const jobs = [...byPr.entries()];
console.log(
  `[bench] ${jobs.length} PRs in ${repo} · review-concurrent=${reviewConcurrent}`,
);
if (jobs.length === 0) throw new Error(`No PRs for ${repo}`);
const baseOptions = parseArgs([
  "review",
  repo,
  String(jobs[0][0]),
  ...reviewFlags,
]);

await mapPool(jobs, reviewConcurrent, async ([number, comments]) => {
  const gold = comments
    .filter((row) => row.label === 1)
    .map((row) => ({
      path: row.path,
      from: row.from_line,
      to: row.to_line,
      category: row.category,
      note: row.note,
    }));
  const options = { ...baseOptions, prNumber: number };
  let tokens = 0;
  let cost = 0;
  let costKnown = true;
  const started = performance.now();
  const response = await reviewPullRequest(client, options, async (usage) => {
    tokens += usage.tokensIn + usage.tokensOut;
    if (usage.cost === undefined) costKnown = false;
    else cost += usage.cost;
  });
  const ms = performance.now() - started;
  const predicted = parseFindings(response.text);
  const pairs = matchPairs(predicted, gold);
  const matchedPredicted = new Set(pairs.map((pair) => pair.predicted));
  const matchedGold = new Set(pairs.map((pair) => pair.gold));
  const counts = matchSpans(predicted, gold);
  const scored = scores(counts);
  reports.push({
    pr: number,
    gold: gold.length,
    predicted: predicted.length,
    ...counts,
    ...scored,
    ms,
    tokens,
    cost,
    costKnown,
  });
  details.push({
    pr: number,
    ms,
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
    }s  ${tokens} tok  $${costKnown ? cost.toFixed(4) : "unknown"}`,
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
  maxPrMonthsNote: "init window is not included; use --max-pr-months=3 on init",
  prs: reports.length,
  f1,
  precision,
  recall,
  avgTimeMs: average(reports.map((row) => row.ms)),
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
  }s  avgTok=${result.avgTokens.toFixed(0)}  avgCost=$${
    costKnown ? result.avgCost.toFixed(4) : "unknown"
  }  totalCost=$${costKnown ? totalCost.toFixed(4) : "unknown"}`,
);

await Deno.mkdir("benchmark/results", { recursive: true });
const slug = repo.replace("/", "-");
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
