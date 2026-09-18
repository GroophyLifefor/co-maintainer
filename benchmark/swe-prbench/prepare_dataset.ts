import {
  isNotFound,
  readTextFile,
  writeTextFile,
} from "../../src/util/runtime.ts";
// Converts a local swe-prbench `prs.jsonl` (download `dataset/prs.jsonl` from
// https://huggingface.co/datasets/foundry-ai/swe-prbench) into the Row shape
// run.ts expects, restricted to --repos=owner/a,owner/b.
//
// Only top-level review comments anchored to a diff line are kept as gold —
// a reply (`replyTo` set) responds to a finding rather than raising a new
// one, and a comment with no `line` isn't anchored to code a model's finding
// can be matched against.
//
// `ref_before` (see src/pr/snapshot.ts) is pinned to an epoch sentinel for
// every row, so run.ts strips the PR's entire real comment/review history
// from the model's context — not just the gold quotes. Every PR here is
// real and already merged, so without this the model would review with the
// answers already sitting in front of it.

type SourceComment = {
  body: string;
  path: string;
  line: number | null;
  replyTo: { id: string } | null;
};

type SourceRow = {
  task_id: string;
  repo: string;
  pr_number: number;
  base_commit: string;
  head_commit: string;
  human_review_comments: SourceComment[];
};

/** Before every existing GitHub comment/review on these PRs — see above. */
const REF_BEFORE = "1970-01-01T00:00:00Z";

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const args = process.argv.slice(2);
const srcPath = flag(args, "source") ?? "benchmark/swe-prbench/prs.jsonl";
const repos = (
  flag(args, "repos") ?? "pipecat-ai/pipecat,stylelint/stylelint"
).split(",");
const outPath = flag(args, "out") ?? "benchmark/swe-prbench/dataset.json";

let text: string;
try {
  text = await readTextFile(srcPath);
} catch (error) {
  if (isNotFound(error)) {
    throw new Error(
      `Missing ${srcPath}; download dataset/prs.jsonl from https://huggingface.co/datasets/foundry-ai/swe-prbench there first`,
    );
  }
  throw error;
}
const rows: SourceRow[] = text
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const selected = rows.filter((row) => repos.includes(row.repo));
if (selected.length === 0) {
  throw new Error(`No rows in ${srcPath} for --repos=${repos.join(",")}`);
}

const out: Record<string, unknown>[] = [];
for (const row of selected) {
  const gold = row.human_review_comments.filter(
    (c) => c.replyTo === null && c.line !== null,
  );
  if (gold.length === 0) {
    console.log(`skip ${row.task_id}: no anchored top-level comment`);
    continue;
  }

  for (const c of gold) {
    out.push({
      repo: row.repo,
      pr: row.pr_number,
      path: c.path,
      from_line: c.line,
      to_line: c.line,
      side: "RIGHT",
      quote: c.body,
      why: c.body,
      base_commit: row.base_commit,
      head_commit: row.head_commit,
      ref_before: REF_BEFORE,
    });
  }
}

if (out.length === 0) {
  throw new Error("No gold rows produced — nothing to write");
}
await writeTextFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  `wrote ${outPath}: ${out.length} gold rows across ${new Set(out.map((r) => r.repo)).size} repos`,
);
