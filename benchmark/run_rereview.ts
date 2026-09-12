import { parseArgs } from "../src/cli/args.ts";
import { reposDir } from "../src/config.ts";
import { GhClient } from "../src/github/gh.ts";
import { average, scores } from "./metrics.ts";
import { matchPairs, matchSpans } from "./match.ts";
import type { ParsedFinding } from "../src/pr/findings.ts";
import { judgeMatches } from "./judge.ts";
import { cloneDirFor, comaintainerRunner, ocrRunner } from "./runners.ts";

// Gold sourced from a re-review round: the diff a human reviewer saw was the
// incremental change between round_base_commit (what round N-1 left off at)
// and round_commit (what the author pushed in response) — not the whole PR.
// See benchmark/README.md.
type Row = {
  /** Absent in a single-repo dataset, where every row belongs to `--repo`. */
  repo?: string;
  pr: number;
  path: string;
  from_line: number;
  to_line: number;
  side: string;
  quote: string;
  why: string;
  round_base_commit: string;
  round_commit: string;
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
/** A filter, not a default: rows carry their own repo, and `--repo` narrows the
 * run to one of them. A dataset whose rows have no repo needs it. */
const repoFilter = flag(args, "repo");
const datasetPath = flag(args, "dataset") ?? "benchmark/rereview_dataset.json";
const reviewConcurrent = intFlag(args, "review-concurrent", 1);
const judgeModel = flag(args, "judge-model") ?? "openai/gpt-oss-120b";
const runnerName = flag(args, "runner") ?? "comaintainer";
if (runnerName !== "comaintainer" && runnerName !== "ocr") {
  throw new Error(`--runner must be comaintainer or ocr, got ${runnerName}`);
}
const ocrCloneRoot = flag(args, "ocr-clone") ?? "benchmark/clones";
const ocrBin = flag(args, "ocr-bin") ?? "ocr";
const reviewFlags = args.filter((arg) =>
  !arg.startsWith("--repo=") &&
  !arg.startsWith("--dataset=") &&
  !arg.startsWith("--review-concurrent=") &&
  !arg.startsWith("--judge-model=") &&
  !arg.startsWith("--runner=") &&
  !arg.startsWith("--ocr-clone=") &&
  !arg.startsWith("--ocr-bin=")
);
const runner = runnerName === "ocr"
  ? ocrRunner(ocrCloneRoot, ocrBin)
  : comaintainerRunner;

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

const repoOf = (row: Row): string => {
  const name = row.repo ?? repoFilter;
  if (!name) {
    throw new Error(
      `Row for PR ${row.pr} has no repo and no --repo was given`,
    );
  }
  return name;
};
const selected = repoFilter
  ? dataset.filter((row) => repoOf(row) === repoFilter)
  : dataset;
if (selected.length === 0) {
  throw new Error(`No rows in ${datasetPath} for --repo=${repoFilter}`);
}
const repos = [...new Set(selected.map(repoOf))].sort();

// Preparation is checked for every repo before the first review, so a missing
// init fails in a second rather than partway through a paid run.
if (runnerName === "comaintainer") {
  for (const name of repos) {
    try {
      await Deno.stat(`${reposDir()}/${name}/PR_REVIEW_GUIDE.md`);
    } catch {
      throw new Error(
        `Missing ${reposDir()}/${name}/PR_REVIEW_GUIDE.md. Init first (not timed):\n  deno task init ${name} --max-pr-months=6 --log-time --env=.env`,
      );
    }
  }
} else {
  for (const name of repos) {
    const dir = cloneDirFor(ocrCloneRoot, name);
    try {
      await Deno.stat(`${dir}/.git`);
    } catch {
      throw new Error(
        `Missing clone ${dir}. Prepare it first (not timed):\n  git clone https://github.com/${name} ${dir}`,
      );
    }
  }
}

// One job per (repo, PR): two repos can share a PR number.
const byPr = new Map<string, Row[]>();
for (const row of selected) {
  const key = `${repoOf(row)}#${row.pr}`;
  const list = byPr.get(key) ?? [];
  list.push(row);
  byPr.set(key, list);
}
const client = new GhClient();
const reports: {
  repo: string;
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
  repo: string;
  pr: number;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  tokens: number;
  cost: number;
  costKnown: boolean;
  review: string;
  predicted: ParsedFinding[];
  gold: {
    path: string;
    from: number;
    to: number;
    quote: string;
    why: string;
  }[];
  pairs: { predicted: number; gold: number }[];
  unmatchedPredicted: number[];
  unmatchedGold: number[];
}[] = [];

const jobs = [...byPr.values()];
console.log(
  `[bench-rereview] ${jobs.length} PRs across ${repos.length} repos (${
    repos.join(", ")
  }) · runner=${runnerName} · review-concurrent=${reviewConcurrent}`,
);
// parseArgs resolves tokens and models, which do not vary by repo, but it also
// stamps the repo into the options, so each repo needs its own base.
// The PR number here is a placeholder: every job overrides `prNumber` with its
// own, so only the repo and the resolved credentials matter.
const baseByRepo = new Map(
  repos.map((name) => [
    name,
    parseArgs(["review", name, "1", ...reviewFlags]),
  ]),
);

await mapPool(jobs, reviewConcurrent, async (rows) => {
  const repo = repoOf(rows[0]);
  const number = rows[0].pr;
  const gold = rows.map((row) => ({
    path: row.path,
    from: row.from_line,
    to: row.to_line,
    quote: row.quote,
    why: row.why,
  }));
  const options = { ...baseByRepo.get(repo)!, prNumber: number };
  const snapshot = {
    base: rows[0].round_base_commit,
    commit: rows[0].round_commit,
    before: rows[0].ref_before,
  };
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let costKnown = true;
  const started = performance.now();
  let result;
  try {
    result = await runner(client, options, snapshot);
    tokensIn = result.tokensIn;
    tokensOut = result.tokensOut;
    cost = result.cost;
    costKnown = result.costKnown;
  } catch (error) {
    const ms = performance.now() - started;
    console.log(`${repo}#${number}  FAILED  ${String(error)}`);
    reports.push({
      repo,
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
      repo,
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
  const predicted = result.findings;
  const pairs = matchPairs(predicted, gold);
  const matchedPredicted = new Set(pairs.map((pair) => pair.predicted));
  const matchedGold = new Set(pairs.map((pair) => pair.gold));

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
    repo,
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
    repo,
    pr: number,
    ms,
    tokensIn,
    tokensOut,
    tokens,
    cost,
    costKnown,
    review: result.text,
    predicted,
    gold,
    pairs,
    unmatchedPredicted: predicted.map((_, i) => i).filter((i) =>
      !matchedPredicted.has(i)
    ),
    unmatchedGold: gold.map((_, i) => i).filter((i) => !matchedGold.has(i)),
  });
  console.log(
    `${repo}#${number}  tp=${counts.tp} fp=${counts.fp} fn=${counts.fn}  predicted=${predicted.length}/${gold.length} gold  ${
      (ms / 1000).toFixed(1)
    }s  in=${tokensIn} out=${tokensOut} total=${tokens} tok  $${
      costKnown ? cost.toFixed(4) : "unknown"
    }`,
  );
});
reports.sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr);

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
// Per-repo scores are pooled, not averaged: a repo contributing more gold rows
// should weigh more, exactly as it does in the overall counts.
const perRepo = repos.map((name) => {
  const rows = reports.filter((row) => row.repo === name);
  const counts = rows.reduce(
    (sum, row) => ({
      tp: sum.tp + row.tp,
      fp: sum.fp + row.fp,
      fn: sum.fn + row.fn,
    }),
    { tp: 0, fp: 0, fn: 0 },
  );
  return {
    repo: name,
    prs: rows.length,
    ...counts,
    ...scores(counts),
    avgTimeMs: average(rows.map((row) => row.ms)),
    avgTokensIn: average(rows.map((row) => row.tokensIn)),
    avgTokensOut: average(rows.map((row) => row.tokensOut)),
    avgTokens: average(rows.map((row) => row.tokens)),
    totalCost: rows.reduce((sum, row) => sum + row.cost, 0),
  };
});
const result = {
  repos,
  runner: runnerName,
  gold:
    "re-review benchmark — real human comments from a later review round, shown only the incremental diff since the prior round",
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
  perRepo,
  reports,
};

for (const row of perRepo) {
  console.log(
    `  ${row.repo}  PRs=${row.prs}  F1=${row.f1.toFixed(3)}  P=${
      row.precision.toFixed(3)
    }  R=${row.recall.toFixed(3)}  tp=${row.tp} fp=${row.fp} fn=${row.fn}  ` +
      `avgTok(in/out)=${row.avgTokensIn.toFixed(0)}/${
        row.avgTokensOut.toFixed(0)
      }`,
  );
}
console.log(
  `\nALL (${repos.length} repos)  PRs=${result.prs}  F1=${f1.toFixed(3)}  P=${
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
// A multi-repo run is named after its dataset, so two runs over different gold
// sets do not overwrite each other.
const datasetName = datasetPath.split(/[\/]/).pop()?.replace(/\.json$/, "") ??
  "rereview";
const slug = repoFilter
  ? `${repoFilter.replace("/", "-")}-${datasetName}-${runnerName}`
  : `${datasetName}-${runnerName}`;
const out = `benchmark/results/${slug}.json`;
await Deno.writeTextFile(out, `${JSON.stringify(result, null, 2)}\n`);
details.sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr);
const detailDir = `benchmark/results/${slug}`;
await Deno.mkdir(detailDir, { recursive: true });
await Deno.writeTextFile(
  `${detailDir}/detail.json`,
  `${JSON.stringify({ repos, ...scores(totals), details }, null, 2)}\n`,
);
for (const item of details) {
  await Deno.writeTextFile(
    `${detailDir}/${item.repo.replace("/", "-")}-${item.pr}.md`,
    item.review,
  );
}
console.log(`wrote ${out}`);
console.log(
  `wrote ${detailDir}/detail.json and ${details.length} review .md files`,
);
