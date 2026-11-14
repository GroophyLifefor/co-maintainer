import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tempDirSync } from "../src/testing/runtime.ts";
import { loadReports, render, stats, summarize } from "./sim_report_summary.ts";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "sim_report_summary.ts",
);

type Score = {
  name: string;
  value: number | null;
  fakeAi?: boolean;
  skipped?: string;
  data?: Record<string, unknown>;
};

/** A report as `--output` writes it, cut down to what the summary reads. */
function report(mode: "fake" | "live", flows: Record<string, Score[]>) {
  return {
    schemaVersion: 3,
    tool: "e2e:simulate",
    passed: true,
    ai: { mode, highModel: "m" },
    flows: Object.entries(flows).map(([name, scores]) => ({
      name,
      passed: true,
      scores,
    })),
  };
}

/** The per-check scores of one review-checks run. */
function checkScores(rows: [string, number, number, number][]): Score[] {
  return rows.map(([check, baselineCatches, checksCatches, falseWithTag]) => ({
    name: check,
    value: checksCatches,
    fakeAi: false,
    data: {
      check,
      baselineCatches,
      checksCatches,
      falseWithTag,
      taggedCatches: 0,
    },
  }));
}

function withDir(
  files: Record<string, unknown>,
  run: (dir: string) => void,
): void {
  const dir = tempDirSync();
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(
        join(dir, name),
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Reports read back the way the script reads them. */
function loaded(raws: unknown[]) {
  let out: ReturnType<typeof loadReports>["reports"] = [];
  withDir(
    Object.fromEntries(raws.map((raw, index) => [`${index}.json`, raw])),
    (dir) => {
      out = loadReports(dir).reports;
    },
  );
  return out;
}

test("stats: mean, sample standard deviation, min and max", () => {
  const got = stats([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(got.mean, 5);
  assert.equal(got.sd.toFixed(4), "2.1381");
  assert.deepEqual([got.min, got.max], [2, 9]);
  assert.deepEqual(stats([3]), { mean: 3, sd: 0, min: 3, max: 3 });
});

test("reports group by flow and score, skipped and unknown values stay out of the numbers", () => {
  const reports = [
    report("live", {
      init: [
        { name: "AI calls", value: 4 },
        { name: "AI cost", value: null },
      ],
    }),
    report("live", {
      init: [
        { name: "AI calls", value: 6 },
        { name: "AI cost", value: 0.5 },
      ],
      other: [{ name: "x", value: 1, skipped: "no data" }],
    }),
  ];
  withDir(
    {
      "a.json": reports[0],
      "b.json": reports[1],
      "notes.json": { hello: 1 },
      "broken.json": "{",
    },
    (dir) => {
      const { reports: loaded, skipped } = loadReports(dir);
      assert.equal(loaded.length, 2);
      assert.equal(skipped.length, 2);
      const init = summarize(loaded).get("init")!;
      const calls = init.find((stat) => stat.score === "AI calls")!;
      assert.deepEqual(
        [calls.runs, calls.mean, calls.min, calls.max, calls.sd.toFixed(4)],
        [2, 5, 4, 6, "1.4142"],
      );
      const cost = init.find((stat) => stat.score === "AI cost")!;
      assert.deepEqual([cost.runs, cost.missing, cost.mean], [1, 1, 0.5]);
      const other = summarize(loaded).get("other")!;
      assert.deepEqual([other[0]!.runs, other[0]!.missing], [0, 1]);
    },
  );
});

test("a fake AI score is marked in the output", () => {
  const text = render(
    loaded([
      report("fake", { local: [{ name: "AI calls", value: 3, fakeAi: true }] }),
    ]),
  );
  assert.match(
    text,
    /AI calls · mean 3 · sd 0 · min 3 · max 3 · 1 runs · fake AI, not a measurement/,
  );
});

test("review-checks: the pass rule per check over the runs, with its numbers", () => {
  const run = (rows: [string, number, number, number][], untagged: number) =>
    report("live", {
      "review-checks": [
        ...checkScores(rows),
        { name: "false findings without a tag, checks arm", value: untagged },
        { name: "false findings, baseline", value: 1 },
        { name: "false findings, checks arm", value: 2 },
      ],
    });
  const reports = [
    run(
      [
        ["C1", 0, 1, 0],
        ["C2", 1, 1, 0],
        ["C3", 0, 1, 2],
      ],
      1,
    ),
    run(
      [
        ["C1", 0, 0, 1],
        ["C2", 1, 1, 0],
        ["C3", 0, 1, 2],
      ],
      0,
    ),
    run(
      [
        ["C1", 0, 1, 0],
        ["C2", 1, 0, 0],
        ["C3", 0, 0, 1],
      ],
      2,
    ),
  ];
  const text = render(loaded(reports));
  assert.match(text, /review-checks: the pass rule of issue 80 over 3 runs/);
  assert.match(
    text,
    /C1 {2}pass · checks caught it in 2 of 3 runs, baseline in 0 · caught only with the checks in 2 · false findings with \[C1\]: 0\.33 per run/,
  );
  assert.match(
    text,
    /C2 {2}fail: no catch the baseline missed · checks caught it in 2 of 3 runs, baseline in 3/,
  );
  assert.match(
    text,
    /C3 {2}fail: more than one false finding with its id per run · .* 1\.67 per run/,
  );
  assert.match(text, /C4 {2}fail: no runs/);
  assert.match(text, /False findings without a tag, checks arm: 1 per run/);
  assert.doesNotMatch(text, /provisional/);
  assert.doesNotMatch(text, /fake AI: these verdicts/);
  const one = render(loaded([reports[0]!]));
  assert.match(one, /provisional/);
});

test("the script prints the summary of a directory, and refuses one with no report", () => {
  withDir(
    { "r.json": report("live", { init: [{ name: "AI calls", value: 2 }] }) },
    (dir) => {
      const result = spawnSync(process.execPath, [script, dir], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^1 report · live/);
      assert.match(result.stdout, /init · 1 runs · 1 passed/);
    },
  );
  withDir({}, (dir) => {
    const result = spawnSync(process.execPath, [script, dir], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No e2e:simulate report/);
  });
});
