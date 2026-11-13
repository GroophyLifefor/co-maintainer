// Runs bench-core-v3 for real as a child process, against a fake gh and a fake
// OpenRouter server. No network and no paid call. The script writes under the
// working directory, so each test gets a temporary one and the real results
// folder is never touched.
//
// The benchmark builds its own provider for every review, so the in-process
// `CM_FAKE_AI` switch never reaches it. The fake server is the same fake AI at
// the wire, and it keeps every request body so a test can read the prompt.
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FakeOpenRouter,
  startFakeOpenRouter,
} from "../../src/testing/fake_openrouter.ts";
import {
  envToObject,
  makeTempDir,
  mkdir,
  readTextFile,
  remove,
  stat,
  writeTextFile,
} from "../../src/util/runtime.ts";
import { Command, runtimeExecPath } from "../../src/testing/runtime.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO = "o/r";
const BASE = "o-r-comaintainer";
const MARKER = "MARKER-SENTENCE-FOR-THE-PROMPT-FILE";

// Both pull requests get this one finding. On the defective row it sits on
// the gold line, so the match needs no judge model. On the control row it is
// a severe finding, so it counts as a false one.
const REVIEW_JSON = JSON.stringify({
  findings: [
    {
      severity: "P2",
      blocking: false,
      path: "src/app.ts",
      lineFrom: 4,
      lineTo: 4,
      symbol: "helper",
      title: "The helper ignores its argument",
      body: "The helper accepts an argument but never reads it, so the new behavior is never applied.",
    },
  ],
});

const LEDGER = {
  rows: [
    {
      repo: REPO,
      pr: 1,
      is_control: true,
      base_commit: "a1",
      head_commit: "b1",
      fix_commit: null,
      merge_commit: "c1",
      ref_before: "1970-01-01T00:00:00Z",
      defects: [],
    },
    {
      repo: REPO,
      pr: 2,
      is_control: false,
      base_commit: "a2",
      head_commit: "b2",
      fix_commit: null,
      merge_commit: "c2",
      ref_before: "1970-01-01T00:00:00Z",
      defects: [
        {
          id: "X1",
          path: "src/app.ts",
          from_line: 4,
          to_line: 4,
          side: "right",
          axis: "diff_local",
          class: "logic",
          quote: "x",
          why: "y",
        },
      ],
    },
  ],
};

// `gh api <endpoint>`: only the endpoints a snapshot review reads.
const FAKE_GH = `
const endpoint = process.argv.slice(2).find((arg) => arg !== "api") ?? "";
const out = (body) => process.stdout.write(JSON.stringify(body) + "\\n");
if (/\\/pulls\\/\\d+$/.test(endpoint)) {
  out({ title: "t", body: "b", state: "open", head: { sha: "b" }, base: { ref: "main" } });
} else if (/\\/(comments|reviews)/.test(endpoint)) {
  out([]);
} else if (/\\/compare\\//.test(endpoint)) {
  out({ files: [{ filename: "src/app.ts", changes: 1, additions: 1, deletions: 0,
    patch: "@@ -1,3 +1,4 @@\\n a\\n b\\n c\\n+d" }] });
} else {
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}
`;

type Sandbox = {
  root: string;
  server: FakeOpenRouter;
  run: (extra: string[]) => Promise<{ code: number; out: string; err: string }>;
  read: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  /** The system prompt of every review request so far. */
  reviewSystems: () => string[];
  cleanup: () => Promise<void>;
};

async function sandbox(): Promise<Sandbox> {
  const root = await makeTempDir({ prefix: "cm-core-v3-" });
  const server = await startFakeOpenRouter("success", {
    reviewJson: REVIEW_JSON,
  });
  await mkdir(join(root, "repos", REPO), { recursive: true });
  await writeTextFile(
    join(root, "repos", REPO, "PR_REVIEW_GUIDE.md"),
    "# Guide\n\nBe terse.\n",
  );
  await writeTextFile(join(root, "gh.mjs"), FAKE_GH);
  await writeTextFile(join(root, "ledger.json"), JSON.stringify(LEDGER));
  await writeTextFile(join(root, "checks.md"), `${MARKER}\n`);
  await writeTextFile(
    join(root, "config.json"),
    JSON.stringify({
      auth: "gh",
      ai: "openrouter",
      token: "fake-key",
      lowModel: "fake/model",
      highModel: "fake/model",
    }),
  );
  const env = {
    ...envToObject(),
    CM_CONFIG_PATH: join(root, "config.json"),
    CM_REPOS_DIR: join(root, "repos"),
    XDG_CONFIG_HOME: join(root, "xdg"),
    XDG_CACHE_HOME: join(root, "cache"),
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    CM_GH_BIN: process.execPath,
    CM_GH_SCRIPT: join(root, "gh.mjs"),
    CM_OPENROUTER_URL: server.url,
    CM_FAKE_AI: undefined,
    CM_FAKE_REVIEW_FILE: undefined,
    CO_MAINTAINER_AI: undefined,
    CO_MAINTAINER_TOKEN: undefined,
  };
  return {
    root,
    server,
    async run(extra) {
      const result = await new Command(runtimeExecPath(), {
        args: [
          join(projectRoot, "benchmark/core_v3/run.ts"),
          `--ledger=${join(root, "ledger.json")}`,
          `--repo=${REPO}`,
          "--review-upstream",
          "--disable-codegraph",
          ...extra,
        ],
        cwd: root,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: result.code,
        out: new TextDecoder().decode(result.stdout),
        err: new TextDecoder().decode(result.stderr),
      };
    },
    read: (path) => readTextFile(join(root, "benchmark/core_v3/results", path)),
    exists: (path) =>
      stat(join(root, "benchmark/core_v3/results", path)).then(
        () => true,
        () => false,
      ),
    reviewSystems() {
      // Only a review asks for the findings schema.
      return server.requests
        .filter((body) => body.response_format !== undefined)
        .map((body) => {
          const messages = body.messages as { role: string; content: string }[];
          return messages.find((m) => m.role === "system")?.content ?? "";
        });
    },
    async cleanup() {
      await server.close();
      await remove(root, { recursive: true });
    },
  };
}

function must(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
}

test("a labelled run leaves the baseline and a second label beside it", async () => {
  const box = await sandbox();
  try {
    const plain = await box.run([]);
    must(plain.code === 0, `baseline run failed: ${plain.err}${plain.out}`);
    const baseline = await box.read(`${BASE}.json`);
    must(
      JSON.parse(baseline).controlFalsePositiveTotal === 1,
      `the fake review is scored: ${plain.out}`,
    );

    for (const label of ["checks", "other"]) {
      const labelled = await box.run([`--label=${label}`]);
      must(labelled.code === 0, `${label} run failed: ${labelled.err}`);
    }

    must(
      (await box.read(`${BASE}.json`)) === baseline,
      "the baseline result was overwritten by a labelled run",
    );
    must(JSON.parse(baseline).label === null, "the baseline has no label");
    must(
      await box.exists(`${BASE}/detail.json`),
      "the baseline detail.json is still there",
    );
    for (const label of ["checks", "other"]) {
      const result = JSON.parse(await box.read(`${BASE}-${label}.json`));
      must(result.label === label, `${label}: label is recorded`);
      must(result.runs === 1, `${label}: one run`);
      must(
        await box.exists(`${BASE}-${label}/detail.json`),
        `${label}: detail.json`,
      );
      must(
        await box.exists(`${BASE}-${label}/o-r-1.md`),
        `${label}: review .md for the control row`,
      );
      must(
        await box.exists(`${BASE}-${label}/o-r-2.md`),
        `${label}: review .md for the defective row`,
      );
    }
  } finally {
    await box.cleanup();
  }
});

test("--runs=2 writes each run and reports mean and spread", async () => {
  const box = await sandbox();
  try {
    const run = await box.run(["--runs=2", "--label=twice"]);
    must(run.code === 0, `run failed: ${run.err}${run.out}`);
    for (const n of [1, 2]) {
      const one = JSON.parse(await box.read(`${BASE}-twice-run${n}.json`));
      must(one.run === n && one.runs === 2, `run ${n} is numbered`);
      must(
        await box.exists(`${BASE}-twice-run${n}/detail.json`),
        `run ${n} detail.json`,
      );
    }
    const summary = JSON.parse(await box.read(`${BASE}-twice-runs.json`));
    must(summary.runs === 2, "summary names the run count");
    must(summary.perRun.length === 2, "summary keeps both runs");
    // The fake AI answers the same way each time: one hit on the defective
    // row and one severe finding on the control row. The spread math itself
    // is tested in repeat.test.ts, where the runs differ.
    must(summary.summary.recall.mean === 1, "recall mean");
    must(summary.summary.recall.stddev === 0, "recall stddev with equal runs");
    must(summary.summary.controlFalsePositiveTotal.mean === 1, "control fp");
    must(summary.summary.controlNiceToHaveTotal.mean === 0, "P3 counted apart");
    must(run.out.includes("MEAN AND SPREAD over 2 runs"), "console summary");
    // The single-run names are not used when the run repeats.
    must(!(await box.exists(`${BASE}-twice.json`)), "no unnumbered result");
  } finally {
    await box.cleanup();
  }
});

test("--system-prompt-file reaches every review in the run", async () => {
  const box = await sandbox();
  try {
    const without = await box.run([]);
    must(without.code === 0, `plain run failed: ${without.err}${without.out}`);
    const plain = box.reviewSystems();
    must(plain.length >= 2, `one review per pull request, saw ${plain.length}`);
    must(
      plain.every((system) => !system.includes(MARKER)),
      "the marker is absent without the flag",
    );
    const seen = plain.length;

    const run = await box.run([
      `--system-prompt-file=${join(box.root, "checks.md")}`,
      "--runs=2",
    ]);
    must(run.code === 0, `run failed: ${run.err}${run.out}`);
    const added = box.reviewSystems().slice(seen);
    // Two pull requests in two runs. A review that retries sends more.
    must(added.length >= 4, `expected 4 reviews, saw ${added.length}`);
    for (const system of added) {
      must(
        system.includes(`CUSTOM REVIEW INSTRUCTIONS:\n${MARKER}`),
        "a review went out without the prompt file",
      );
      must(system.includes("Be terse."), "the guide is still in the prompt");
    }
    const result = JSON.parse(await box.read(`${BASE}-run1.json`));
    must(
      String(result.systemPromptFile).endsWith("checks.md"),
      "the result names the prompt file",
    );
  } finally {
    await box.cleanup();
  }
});

test("a bad label, a bad run count, a missing prompt file and ocr with a prompt file are refused", async () => {
  const box = await sandbox();
  try {
    const label = await box.run(["--label=../escape"]);
    must(label.code !== 0, "path in a label is refused");
    must(label.err.includes("--label"), `label error: ${label.err}`);

    const runs = await box.run(["--runs=0"]);
    must(runs.code !== 0, "--runs=0 is refused");
    must(runs.err.includes("--runs"), `runs error: ${runs.err}`);

    const missing = await box.run([`--system-prompt-file=${box.root}/nope.md`]);
    must(missing.code !== 0, "a missing prompt file is refused");
    must(
      missing.err.includes("--system-prompt-file"),
      `prompt file error: ${missing.err}`,
    );

    const ocr = await box.run([
      "--runner=ocr",
      `--system-prompt-file=${join(box.root, "checks.md")}`,
    ]);
    must(ocr.code !== 0, "ocr with a prompt file is refused");
    must(ocr.err.includes("--runner=ocr"), `ocr error: ${ocr.err}`);
    must(
      !(await box.exists(`${BASE}.json`)),
      "a refused run writes no results",
    );
    must(
      box.server.requests.length === 0,
      "a refused run sends no request to the AI",
    );
  } finally {
    await box.cleanup();
  }
});
