import { parseArgs } from "../../src/cli/args.ts";
import { reposDir } from "../../src/config.ts";
import { GhClient } from "../../src/github/gh.ts";
import { average, scores } from "../core_v2/metrics.ts";
import { matchPairs, matchSpans } from "../core_v2/match.ts";
import type { ParsedFinding } from "../../src/pr/findings.ts";
import { readSuggestion, suggestionAnchor } from "../../src/pr/suggestion.ts";
import type { Json } from "../../src/types.ts";
import { judgeMatches } from "../core_v2/judge.ts";
import {
  cloneDirFor,
  comaintainerRunner,
  ocrRunner,
} from "../core_v2/runners.ts";
import {
  isNotFound,
  mkdir,
  readTextFile,
  stat,
  writeTextFile,
} from "../../src/util/runtime.ts";

// Ledger sourced from GroophyLifefor/heap-analysis (bench core v3, see
// plan.md in that repo's working tree -- gitignored, the answer key). Unlike
// swe-prbench/core_v2, gold here is not a human review comment: it is a
// defect we ourselves wrote in, hand-verified, and know the exact location
// and behavior of. Two differences from run.ts/run_rereview.ts, both from
// plan.md §11.2:
//   1. Jobs come from every ledger row, not from rows grouped by gold --
//      a control PR (defects: []) still gets reviewed, since without it
//      precision can't be measured at all.
//   2. A control PR is scored differently: any P0/P1/P2 finding on it is a
//      false positive by definition (there is nothing real to find). P3
//      findings are recorded but not counted, the tool is free to nitpick.
type LedgerDefect = {
  id: string;
  path: string;
  from_line: number;
  to_line: number;
  side: string;
  axis: string;
  class: string;
  quote: string;
  why: string;
};
type LedgerRow = {
  repo: string;
  pr: number;
  is_control: boolean;
  base_commit: string;
  head_commit: string;
  fix_commit: string | null;
  merge_commit: string;
  ref_before: string;
  defects: LedgerDefect[];
};

function flag(args: string[], name: string): string | undefined {
  return args
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
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

const SEVERE = new Set(["P0", "P1", "P2"]);

const squash = (value: string) => value.replace(/\s+/g, " ").trim();

// suggested: findings that wrote a suggestion. valid: ones publish would keep
// (same checks against the same diff). matchesFix: valid, non-empty ones whose
// code appears, whitespace aside, in the file at the ledger's fix commit.
async function suggestionStats(
  client: GhClient,
  row: LedgerRow,
  findings: ParsedFinding[],
): Promise<{ suggested: number; valid: number; matchesFix: number }> {
  const suggested = findings.filter((f) => readSuggestion(f.excerpt));
  if (suggested.length === 0) return { suggested: 0, valid: 0, matchesFix: 0 };
  const compared = await client.request<Json>(
    `repos/${row.repo}/compare/${row.base_commit}...${row.head_commit}`,
  );
  const patches = new Map(
    ((compared.files as Json[] | undefined) ?? []).map((file) => [
      String(file.filename ?? ""),
      String(file.patch ?? ""),
    ]),
  );
  let valid = 0;
  let matchesFix = 0;
  for (const finding of suggested) {
    if (!suggestionAnchor(finding, patches.get(finding.path))) continue;
    valid++;
    const code = squash(readSuggestion(finding.excerpt)!.code);
    if (!row.fix_commit || code === "") continue;
    const file = await client
      .request<Json>(
        `repos/${row.repo}/contents/${finding.path}?ref=${row.fix_commit}`,
      )
      .catch(() => undefined);
    const base64 = String(file?.content ?? "").replaceAll("\n", "");
    const fixed = new TextDecoder().decode(
      Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
    );
    if (squash(fixed).includes(code)) matchesFix++;
  }
  return { suggested: suggested.length, valid, matchesFix };
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const repoFilter = flag(args, "repo");
const ledgerPath = flag(args, "ledger") ?? "benchmark/core_v3/ledger.json";
const reviewConcurrent = intFlag(args, "review-concurrent", 1);
const judgeModel = flag(args, "judge-model") ?? "openai/gpt-oss-120b";
const runnerName = flag(args, "runner") ?? "comaintainer";
if (runnerName !== "comaintainer" && runnerName !== "ocr") {
  throw new Error(`--runner must be comaintainer or ocr, got ${runnerName}`);
}
const ocrCloneRoot = flag(args, "ocr-clone") ?? "benchmark/core_v3/clones";
const ocrBin = flag(args, "ocr-bin") ?? "ocr";
const reviewFlags = args.filter(
  (arg) =>
    !arg.startsWith("--repo=") &&
    !arg.startsWith("--ledger=") &&
    !arg.startsWith("--review-concurrent=") &&
    !arg.startsWith("--judge-model=") &&
    !arg.startsWith("--runner=") &&
    !arg.startsWith("--ocr-clone=") &&
    !arg.startsWith("--ocr-bin="),
);
const runner =
  runnerName === "ocr" ? ocrRunner(ocrCloneRoot, ocrBin) : comaintainerRunner;

let ledger: { rows: LedgerRow[] };
try {
  ledger = JSON.parse(await readTextFile(ledgerPath));
} catch (error) {
  if (isNotFound(error)) {
    throw new Error(`Missing ${ledgerPath}; build it first (see plan.md §9)`);
  }
  throw error;
}
if (ledger.rows.length === 0) throw new Error(`Empty ledger ${ledgerPath}`);

const selected = repoFilter
  ? ledger.rows.filter((row) => row.repo === repoFilter)
  : ledger.rows;
if (selected.length === 0) {
  throw new Error(`No rows in ${ledgerPath} for --repo=${repoFilter}`);
}
const repos = [...new Set(selected.map((row) => row.repo))].sort();

if (runnerName === "comaintainer") {
  // reviewPullRequest accepts either PR_REVIEW_GUIDE.md or SKILL.md (the
  // former short-circuits `guide = shortGuide || skill`) -- init only wrote
  // SKILL.md/CODEBASE.md for this repo, so both are checked, not just the
  // (unused here) PR_REVIEW_GUIDE.md name the older bench scripts check.
  for (const name of repos) {
    const hasGuide = await stat(
      `${reposDir()}/${name}/PR_REVIEW_GUIDE.md`,
    ).then(
      () => true,
      () => false,
    );
    const hasSkill = await stat(`${reposDir()}/${name}/SKILL.md`).then(
      () => true,
      () => false,
    );
    if (!hasGuide && !hasSkill) {
      throw new Error(
        `Missing ${reposDir()}/${name}/PR_REVIEW_GUIDE.md or SKILL.md. Init first (not timed, then archive per plan.md §11.1):\n  npm run init ${name} --max-pr-months=6 --max-commits=200 --log-time --env=.env`,
      );
    }
  }
} else {
  for (const name of repos) {
    const dir = cloneDirFor(ocrCloneRoot, name);
    try {
      await stat(`${dir}/.git`);
    } catch {
      throw new Error(
        `Missing clone ${dir}. Prepare it first (not timed):\n  git clone https://github.com/${name} ${dir}`,
      );
    }
  }
}

const client = new GhClient();
type Report = {
  repo: string;
  pr: number;
  isControl: boolean;
  axes: string[];
  gold: number;
  predicted: number;
  tp: number;
  fp: number;
  fn: number;
  /** Control-PR-only: severe (P0-P2) findings on a snapshot with nothing
   * wrong, each one a false positive by definition. Always 0 for a
   * defective row (those go through the usual matched fp instead). */
  controlFalsePositives: number;
  /** Control-PR-only: P3 findings, recorded but never scored. */
  niceToHaves: number;
  precision: number;
  recall: number;
  f1: number;
  ms: number;
  prepMs: number;
  timeKnown: boolean;
  tokensIn: number;
  tokensOut: number;
  tokens: number;
  cost: number;
  costKnown: boolean;
  suggested: number;
  validSuggestions: number;
  suggestionsMatchingFix: number;
};
const reports: Report[] = [];
const details: {
  repo: string;
  pr: number;
  isControl: boolean;
  ms: number;
  prepMs: number;
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

console.log(
  `[bench-core-v3] ${selected.length} PRs across ${repos.length} repos (${repos.join(
    ", ",
  )}) · ${selected.filter((r) => !r.is_control).length} defective, ${
    selected.filter((r) => r.is_control).length
  } control · runner=${runnerName} · review-concurrent=${reviewConcurrent}`,
);
const baseByRepo = new Map(
  await Promise.all(
    repos.map(
      async (name) =>
        [name, await parseArgs(["review", name, "1", ...reviewFlags])] as const,
    ),
  ),
);

await mapPool(selected, reviewConcurrent, async (row) => {
  const options = { ...baseByRepo.get(row.repo)!, prNumber: row.pr };
  const snapshot = {
    base: row.base_commit,
    commit: row.head_commit,
    before: row.ref_before,
  };
  const gold = row.defects.map((d) => ({
    path: d.path,
    from: d.from_line,
    to: d.to_line,
    quote: d.quote,
    why: d.why,
  }));
  const axes = row.defects.map((d) => d.axis);

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
    console.log(`${row.repo}#${row.pr}  FAILED  ${String(error)}`);
    reports.push({
      repo: row.repo,
      pr: row.pr,
      isControl: row.is_control,
      axes,
      gold: gold.length,
      predicted: 0,
      tp: 0,
      fp: 0,
      fn: gold.length,
      controlFalsePositives: 0,
      niceToHaves: 0,
      precision: 0,
      recall: 0,
      f1: 0,
      ms,
      prepMs: 0,
      timeKnown: false,
      tokensIn,
      tokensOut,
      tokens: tokensIn + tokensOut,
      cost,
      costKnown,
      suggested: 0,
      validSuggestions: 0,
      suggestionsMatchingFix: 0,
    });
    details.push({
      repo: row.repo,
      pr: row.pr,
      isControl: row.is_control,
      ms,
      prepMs: 0,
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
  const prepMs = result.prepMs;
  const ms = performance.now() - started - prepMs;
  const predicted = result.findings;
  const suggestions = await suggestionStats(client, row, predicted).catch(
    (error) => {
      console.log(`${row.repo}#${row.pr}  suggestion stats failed  ${error}`);
      return { suggested: 0, valid: 0, matchesFix: 0 };
    },
  );
  const suggestionFields = {
    suggested: suggestions.suggested,
    validSuggestions: suggestions.valid,
    suggestionsMatchingFix: suggestions.matchesFix,
  };

  if (row.is_control) {
    const severe = predicted.filter(
      (f) => f.severity && SEVERE.has(f.severity),
    );
    const nice = predicted.filter((f) => f.severity === "P3");
    reports.push({
      repo: row.repo,
      pr: row.pr,
      isControl: true,
      axes,
      gold: 0,
      predicted: predicted.length,
      tp: 0,
      fp: 0,
      fn: 0,
      controlFalsePositives: severe.length,
      niceToHaves: nice.length,
      precision: 0,
      recall: 0,
      f1: 0,
      ms,
      prepMs,
      timeKnown: true,
      tokensIn,
      tokensOut,
      tokens: tokensIn + tokensOut,
      cost,
      costKnown,
      ...suggestionFields,
    });
    details.push({
      repo: row.repo,
      pr: row.pr,
      isControl: true,
      ms,
      prepMs,
      tokensIn,
      tokensOut,
      tokens: tokensIn + tokensOut,
      cost,
      costKnown,
      review: result.text,
      predicted,
      gold: [],
      pairs: [],
      unmatchedPredicted: predicted.map((_, i) => i),
      unmatchedGold: [],
    });
    console.log(
      `${row.repo}#${row.pr}  CONTROL  severeFP=${severe.length} nice=${nice.length}  ${(
        ms / 1000
      ).toFixed(1)}s (+${(prepMs / 1000).toFixed(1)}s prep)`,
    );
    return;
  }

  const pairs = matchPairs(predicted, gold);
  const matchedPredicted = new Set(pairs.map((p) => p.predicted));
  const matchedGold = new Set(pairs.map((p) => p.gold));
  const leftoverPredicted = predicted
    .map((_, i) => i)
    .filter((i) => !matchedPredicted.has(i));
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
  reports.push({
    repo: row.repo,
    pr: row.pr,
    isControl: false,
    axes,
    gold: gold.length,
    predicted: predicted.length,
    ...counts,
    controlFalsePositives: 0,
    niceToHaves: 0,
    ...scored,
    ms,
    prepMs,
    timeKnown: true,
    tokensIn,
    tokensOut,
    tokens: tokensIn + tokensOut,
    cost,
    costKnown,
    ...suggestionFields,
  });
  details.push({
    repo: row.repo,
    pr: row.pr,
    isControl: false,
    ms,
    prepMs,
    tokensIn,
    tokensOut,
    tokens: tokensIn + tokensOut,
    cost,
    costKnown,
    review: result.text,
    predicted,
    gold,
    pairs,
    unmatchedPredicted: predicted
      .map((_, i) => i)
      .filter((i) => !matchedPredicted.has(i)),
    unmatchedGold: gold.map((_, i) => i).filter((i) => !matchedGold.has(i)),
  });
  console.log(
    `${row.repo}#${row.pr}  tp=${counts.tp} fp=${counts.fp} fn=${counts.fn}  predicted=${predicted.length}/${gold.length} gold  ${(
      ms / 1000
    ).toFixed(1)}s (+${(prepMs / 1000).toFixed(1)}s prep)`,
  );
});
reports.sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr);

const defectiveReports = reports.filter((r) => !r.isControl);
// A review that errored (timeKnown: false) produced no findings and no
// signal either way -- a control row here must not silently count as "0
// severe findings, so clean", it has to be excluded from scoring entirely,
// same as a failed defective row already drops out of the *rate* (though
// not the *count*: its full gold still lands in fn, an honest miss, which
// a failed control row has no equivalent of since it has no gold).
const controlReports = reports.filter((r) => r.isControl);
const scoredControlReports = controlReports.filter((r) => r.timeKnown);
const failedControlReports =
  controlReports.length - scoredControlReports.length;

// Precision/recall/F1 pool every finding across all 30 reviewed PRs, not
// just the 14 with gold (plan.md K2: a severe finding on a control PR is a
// false positive, full stop, meant to feed the same precision this does).
// tp/fn only ever come from defective PRs (a control PR has no gold to
// match or miss); fp comes from both: an unmatched finding on a defective
// PR, or any severe finding on a *successfully reviewed* control PR.
const totals = reports.reduce(
  (sum, row) => {
    if (row.isControl) {
      if (!row.timeKnown) return sum; // excluded, not "0 fp"
      return { ...sum, fp: sum.fp + row.controlFalsePositives };
    }
    return { tp: sum.tp + row.tp, fp: sum.fp + row.fp, fn: sum.fn + row.fn };
  },
  { tp: 0, fp: 0, fn: 0 },
);
const { f1, precision, recall } = scores(totals);

// Per-axis recall (plan.md §11.3): the headline number for each axis is
// what it costs to argue for the architecture behind it (diff_local = base
// review, repo_wide = codegraph, convention = CODEBASE.md, history =
// PR_REVIEW_GUIDE.md).
const axisTotals = new Map<string, { tp: number; fn: number }>();
for (const row of defectiveReports) {
  for (const axis of row.axes) {
    const acc = axisTotals.get(axis) ?? { tp: 0, fn: 0 };
    // A row currently carries exactly one defect, so the row's own tp/fn
    // attributes to that one axis directly.
    acc.tp += row.tp;
    acc.fn += row.fn;
    axisTotals.set(axis, acc);
  }
}
const perAxis = [...axisTotals.entries()].map(([axis, counts]) => ({
  axis,
  ...counts,
  recall: counts.tp + counts.fn === 0 ? 0 : counts.tp / (counts.tp + counts.fn),
}));

const controlFalsePositiveTotal = scoredControlReports.reduce(
  (sum, r) => sum + r.controlFalsePositives,
  0,
);
const controlNiceTotal = scoredControlReports.reduce(
  (sum, r) => sum + r.niceToHaves,
  0,
);
const controlFalsePositiveRate =
  scoredControlReports.length === 0
    ? 0
    : controlFalsePositiveTotal / scoredControlReports.length;

const suggestionTotals = {
  suggested: reports.reduce((sum, r) => sum + r.suggested, 0),
  valid: reports.reduce((sum, r) => sum + r.validSuggestions, 0),
  matchesFix: reports.reduce((sum, r) => sum + r.suggestionsMatchingFix, 0),
  onControlPrs: controlReports.reduce((sum, r) => sum + r.suggested, 0),
};

const costKnown = reports.every((row) => row.costKnown);
const totalCost = reports.reduce((sum, row) => sum + row.cost, 0);

const result = {
  repos,
  runner: runnerName,
  gold: "bench core v3 — seeded, hand-verified defects (GroophyLifefor/heap-analysis), half the PRs are clean controls",
  prs: reports.length,
  defectivePrs: defectiveReports.length,
  controlPrs: controlReports.length,
  failedControlPrs: failedControlReports,
  f1,
  precision,
  recall,
  perAxis,
  controlFalsePositiveTotal,
  controlFalsePositiveRate,
  controlNiceToHaveTotal: controlNiceTotal,
  suggestions: suggestionTotals,
  avgTimeMs: average(reports.filter((r) => r.timeKnown).map((r) => r.ms)),
  avgPrepMs: average(reports.filter((r) => r.timeKnown).map((r) => r.prepMs)),
  avgTokensIn: average(reports.map((r) => r.tokensIn)),
  avgTokensOut: average(reports.map((r) => r.tokensOut)),
  avgTokens: average(reports.map((r) => r.tokens)),
  avgCost: average(reports.map((r) => r.cost)),
  totalCost,
  costKnown,
  reports,
};

console.log(
  `\nALL ${reports.length} PRs (${defectiveReports.length} defective + ${controlReports.length} control)  F1=${f1.toFixed(
    3,
  )}  P=${precision.toFixed(3)}  R=${recall.toFixed(
    3,
  )}  tp=${totals.tp} fp=${totals.fp} fn=${totals.fn}  (fp pools defective mismatches and control severe findings)`,
);
for (const row of perAxis) {
  console.log(
    `  axis=${row.axis}  recall=${row.recall.toFixed(3)}  tp=${row.tp} fn=${row.fn}`,
  );
}
console.log(
  `CONTROL (${scoredControlReports.length}/${controlReports.length} PRs reviewed${
    failedControlReports > 0
      ? `, ${failedControlReports} failed and excluded`
      : ""
  })  severeFalsePositives=${controlFalsePositiveTotal} (${controlFalsePositiveRate.toFixed(
    2,
  )}/PR)  niceToHaves=${controlNiceTotal}`,
);
console.log(
  `SUGGESTIONS  suggested=${suggestionTotals.suggested} valid=${suggestionTotals.valid} matchesFix=${suggestionTotals.matchesFix} onControlPrs=${suggestionTotals.onControlPrs}`,
);
console.log(
  `avgTime=${(result.avgTimeMs / 1000).toFixed(1)}s (+${(
    result.avgPrepMs / 1000
  ).toFixed(
    1,
  )}s prep)  avgTok(in/out/total)=${result.avgTokensIn.toFixed(0)}/${result.avgTokensOut.toFixed(
    0,
  )}/${result.avgTokens.toFixed(0)}  avgCost=$${
    costKnown ? result.avgCost.toFixed(4) : "unknown"
  }  totalCost=$${costKnown ? totalCost.toFixed(4) : "unknown"}`,
);

await mkdir("benchmark/core_v3/results", { recursive: true });
const slug = repoFilter
  ? `${repoFilter.replace("/", "-")}-${runnerName}`
  : `core-v3-${runnerName}`;
const out = `benchmark/core_v3/results/${slug}.json`;
await writeTextFile(out, `${JSON.stringify(result, null, 2)}\n`);
details.sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr);
const detailDir = `benchmark/core_v3/results/${slug}`;
await mkdir(detailDir, { recursive: true });
await writeTextFile(
  `${detailDir}/detail.json`,
  `${JSON.stringify({ repos, ...scores(totals), details }, null, 2)}\n`,
);
for (const item of details) {
  await writeTextFile(
    `${detailDir}/${item.repo.replace("/", "-")}-${item.pr}.md`,
    item.review,
  );
}
console.log(`wrote ${out}`);
console.log(
  `wrote ${detailDir}/detail.json and ${details.length} review .md files`,
);
