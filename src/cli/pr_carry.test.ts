/** A CLI pull request review remembers its findings between runs.
 *
 * These drive the real engine (`reviewPullRequest`) with a scripted model and a
 * scripted GitHub, in a throwaway cache and guide directory. The first run
 * stores its findings. The second run, after the author fixed one and left
 * another, has to report one closed, one open and only the real new finding as
 * new. `--fresh`, a rebuilt guide and a force-push each have to start over.
 */
import { utimes } from "node:fs/promises";
import { beforeEach, test } from "node:test";
import {
  mkdirPath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { parseArgs } from "./args.ts";
import { reviewPullRequest } from "../pr/reviewer.ts";
import { startPrCarry } from "./pr_carry.ts";
import {
  clearPrCarry,
  prSubjectId,
  tryLoadPrCarry,
} from "../local/carry_over_store.ts";
import { cacheGet, cacheSet } from "../store/cache_db.ts";
import { summaryCounts } from "./review_result.ts";
import type {
  AiProvider,
  AiRequest,
  GitHubClient,
  Json,
  Options,
} from "../types.ts";
import type { ResolvedFinding } from "../review/carry_over.ts";

// Each test file runs in its own process, so pointing the environment at one
// throwaway directory here cannot reach the real cache or guides.
const dir = tempDirSync();
setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
setEnv("CM_REPOS_DIR", `${dir}/repos`);
setEnv("CM_APP_DB", `${dir}/app.db`);
setEnv("XDG_CACHE_HOME", `${dir}/cache`);
setEnv("LOCALAPPDATA", `${dir}/localappdata`);

const REPO = "acme/widgets";
const GUIDE = `${dir}/repos/${REPO}/PR_REVIEW_GUIDE.md`;

// Every test starts from a pull request nobody has reviewed yet.
beforeEach(async () => {
  await clearPrCarry(REPO, 7);
  await clearPrCarry(REPO, 8);
});

async function writeGuide(text: string, at?: Date): Promise<void> {
  await mkdirPath(`${dir}/repos/${REPO}`, { recursive: true });
  await writeTextFile(GUIDE, text);
  if (at) await utimes(GUIDE, at, at);
}

function patch(lines: string[]): string {
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
}

function file(path: string, lines: string[]): Json {
  return {
    filename: path,
    status: "added",
    additions: lines.length,
    deletions: 0,
    changes: lines.length,
    patch: patch(lines),
  };
}

type Pull = { head: string; files: Json[]; compare: string | "throws" };

/** A GitHub that answers the four reads a review makes from `state`. */
function fakeGithub(state: Pull): GitHubClient {
  return {
    async request<T>(endpoint: string): Promise<T> {
      if (/\/compare\/.+\.\.\./.test(endpoint)) {
        if (state.compare === "throws") throw new Error("HTTP 404");
        return { status: state.compare } as T;
      }
      if (endpoint.endsWith("/pulls/7")) {
        return {
          title: "Add things",
          body: "",
          head: { sha: state.head },
          base: { ref: "main", sha: "base0" },
        } as T;
      }
      throw new Error(`unexpected request ${endpoint}`);
    },
    async pages<T>(endpoint: string): Promise<T[]> {
      if (endpoint.endsWith("/pulls/7/files")) return state.files as T[];
      if (endpoint.endsWith("/comments") || endpoint.endsWith("/reviews")) {
        return [];
      }
      throw new Error(`unexpected pages ${endpoint}`);
    },
  };
}

function finding(path: string, line: number, title: string) {
  return {
    severity: "P2",
    blocking: false,
    path,
    lineFrom: line,
    lineTo: line,
    title,
    body: `${title}. The value is never validated before it is used.`,
  };
}

type Answer = {
  findings: ReturnType<typeof finding>[];
  previousFindings?: { id: string; state: "open" | "closed" }[];
};

/** A model that answers `answer(prompt)` and keeps every prompt it saw. */
function scriptedModel(answer: (prompt: string) => Answer): {
  ai: AiProvider;
  prompts: string[];
} {
  const prompts: string[] = [];
  return {
    prompts,
    ai: {
      supportsTools: false,
      async complete(request: AiRequest) {
        prompts.push(request.prompt);
        return {
          text: JSON.stringify(answer(request.prompt)),
          tokensIn: 1,
          tokensOut: 1,
          cost: 0,
          model: "fake",
          provider: "openrouter",
        };
      },
    },
  };
}

async function options(): Promise<Options> {
  const parsed = await parseArgs([
    "review",
    REPO,
    "7",
    "--token=test",
    "--low-model=low/model",
    "--high-model=high/model",
    "--disable-codegraph",
    "--review-upstream",
  ]);
  return parsed;
}

/** One CLI run: the carry-over around one engine call, as `review.ts` does. */
async function run(
  state: Pull,
  ai: AiProvider,
  fresh = false,
): Promise<{ resolved: ResolvedFinding[]; warnings: string[] }> {
  const opts = await options();
  const client = fakeGithub(state);
  const carry = await startPrCarry(client, opts, fresh);
  const result = await reviewPullRequest(
    client,
    opts,
    undefined,
    undefined,
    ai,
    undefined,
    carry.extras,
  );
  const resolved = await carry.finish(result);
  return { resolved, warnings: carry.warnings.map((w) => w.code) };
}

const A_LINES = ["const a = read()", "use(a.value)", "done()"];
const B_LINES = ["const b = read()", "use(b.value)", "done()"];

/** Run 1 finds one problem in a.ts and one in b.ts. */
const FIRST = (prompt: string): Answer => {
  if (/PREVIOUS FINDINGS/.test(prompt)) {
    throw new Error("the first run was handed a carry-over block");
  }
  return {
    findings: [
      finding("a.ts", 2, "The first value is not validated"),
      finding("b.ts", 2, "The second value is not validated"),
    ],
  };
};

function states(rows: ResolvedFinding[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.path ?? "", row.state]));
}

test("a first run stores its findings and head", async () => {
  await writeGuide("# Guide\n\nValidate values.\n");
  const model = scriptedModel(FIRST);
  const state: Pull = {
    head: "sha1",
    files: [file("a.ts", A_LINES), file("b.ts", B_LINES)],
    compare: "ahead",
  };
  const { resolved, warnings } = await run(state, model.ai);
  if (summaryCounts(resolved).new !== 2) {
    throw new Error(`expected two new: ${JSON.stringify(states(resolved))}`);
  }
  if (warnings.length) throw new Error(`warnings: ${warnings}`);
  const stored = (await tryLoadPrCarry(REPO, 7)).data;
  if (stored?.headSha !== "sha1" || stored.findings.length !== 2) {
    throw new Error(`stored: ${JSON.stringify(stored)}`);
  }
  if (!stored.findings.every((row) => row.anchorText)) {
    throw new Error("the stored findings have no anchor text");
  }
});

test("a re-run shows one closed, one open and only the real new finding as new", async () => {
  await writeGuide("# Guide\n\nValidate values.\n");
  const first = scriptedModel(FIRST);
  await run(
    {
      head: "sha1",
      files: [file("a.ts", A_LINES), file("b.ts", B_LINES)],
      compare: "ahead",
    },
    first.ai,
  );

  // The author fixed a.ts and left b.ts alone. The model closes F1, raises one
  // new problem in c.ts, and says nothing about F2.
  const second = scriptedModel(() => ({
    findings: [finding("c.ts", 2, "The third value is not validated")],
    previousFindings: [{ id: "F1", state: "closed" }],
  }));
  const { resolved } = await run(
    {
      head: "sha2",
      files: [
        file("a.ts", ["const a = validate(read())", "use(a.value)", "done()"]),
        file("b.ts", B_LINES),
        file("c.ts", ["const c = read()", "use(c.value)", "done()"]),
      ],
      compare: "ahead",
    },
    second.ai,
  );
  const got = states(resolved);
  if (got["a.ts"] !== "closed") throw new Error(`a.ts: ${got["a.ts"]}`);
  if (got["b.ts"] !== "open") throw new Error(`b.ts: ${got["b.ts"]}`);
  if (got["c.ts"] !== "new") throw new Error(`c.ts: ${got["c.ts"]}`);
  const counts = summaryCounts(resolved);
  if (counts.new !== 1 || counts.open !== 1 || counts.closed !== 1) {
    throw new Error(JSON.stringify(counts));
  }
  const prompt = second.prompts[0] ?? "";
  if (!/PREVIOUS FINDINGS/.test(prompt)) {
    throw new Error("the second run was not handed the earlier findings");
  }
  if (!/UNCHANGED SINCE LAST REVIEW[^]*- b\.ts/.test(prompt)) {
    throw new Error("the unchanged file was not listed");
  }

  // What is stored now is what a third run starts from: the open and the new
  // finding, not the closed one.
  const stored = (await tryLoadPrCarry(REPO, 7)).data;
  const paths = (stored?.findings ?? []).map((row) => row.path).sort();
  if (paths.join() !== "b.ts,c.ts" || stored?.headSha !== "sha2") {
    throw new Error(`stored: ${JSON.stringify(stored)}`);
  }
});

/** Runs 1 and 2 are the same for every restart test below. What differs is the
 * thing that happens before run 2. */
async function secondRunWithRestart(
  between: () => Promise<void>,
  second: Pull,
  fresh = false,
): Promise<{
  resolved: ResolvedFinding[];
  prompt: string;
}> {
  await writeGuide("# Guide\n\nValidate values.\n");
  await run(
    {
      head: "sha1",
      files: [file("a.ts", A_LINES), file("b.ts", B_LINES)],
      compare: "ahead",
    },
    scriptedModel(FIRST).ai,
  );
  await between();
  // A model that only finds anything when it is not shown a carry-over block,
  // so a restart is visible in both the prompt and the result.
  const model = scriptedModel((prompt) =>
    /PREVIOUS FINDINGS/.test(prompt)
      ? { findings: [], previousFindings: [{ id: "F1", state: "open" }] }
      : { findings: [finding("c.ts", 2, "The third value is not validated")] },
  );
  const { resolved } = await run(second, model.ai, fresh);
  return { resolved, prompt: model.prompts[0] ?? "" };
}

const SECOND_PUSH: Pull = {
  head: "sha2",
  files: [
    file("a.ts", A_LINES),
    file("b.ts", B_LINES),
    file("c.ts", ["const c = read()", "use(c.value)", "done()"]),
  ],
  compare: "ahead",
};

function assertFresh(result: {
  resolved: ResolvedFinding[];
  prompt: string;
}): void {
  if (/PREVIOUS FINDINGS/.test(result.prompt)) {
    throw new Error("a fresh run was handed the earlier findings");
  }
  if (/UNCHANGED SINCE LAST REVIEW/.test(result.prompt)) {
    throw new Error("a fresh run skipped files as unchanged");
  }
  const counts = summaryCounts(result.resolved);
  if (counts.open !== 0 || counts.closed !== 0 || counts.new !== 1) {
    throw new Error(JSON.stringify(counts));
  }
}

test("--fresh starts over and clears the stored run", async () => {
  const result = await secondRunWithRestart(async () => {}, SECOND_PUSH, true);
  assertFresh(result);
  const stored = (await tryLoadPrCarry(REPO, 7)).data;
  if (stored?.findings.length !== 1) {
    throw new Error("--fresh kept the earlier findings in the store");
  }
});

test("a guide rebuilt since the last run starts fresh", async () => {
  const result = await secondRunWithRestart(async () => {
    const later = new Date(Date.now() + 60_000);
    await writeGuide("# Guide\n\nValidate values.\nBound loops.\n", later);
  }, SECOND_PUSH);
  assertFresh(result);
});

test("a force-push starts fresh", async () => {
  const result = await secondRunWithRestart(async () => {}, {
    ...SECOND_PUSH,
    compare: "diverged",
  });
  assertFresh(result);
});

test("a head GitHub cannot compare starts fresh", async () => {
  const result = await secondRunWithRestart(async () => {}, {
    ...SECOND_PUSH,
    compare: "throws",
  });
  assertFresh(result);
});

test("a push on top of the last head is not a force-push", async () => {
  const result = await secondRunWithRestart(async () => {}, SECOND_PUSH);
  if (!/PREVIOUS FINDINGS/.test(result.prompt)) {
    throw new Error("an ordinary push dropped the carry-over");
  }
});

test("an unreadable cache row warns and still reviews", async () => {
  await writeGuide("# Guide\n\nValidate values.\n");
  await cacheSet("local-review", prSubjectId(REPO, 7), "{not json");
  const model = scriptedModel(FIRST);
  const { resolved, warnings } = await run(
    {
      head: "sha1",
      files: [file("a.ts", A_LINES), file("b.ts", B_LINES)],
      compare: "ahead",
    },
    model.ai,
  );
  if (summaryCounts(resolved).new !== 2) {
    throw new Error("the review did not run without its cache");
  }
  if (!warnings.includes("carry_over_unavailable")) {
    throw new Error(`no warning: ${warnings}`);
  }
});

/** A model that closes a VERIFY entry only when the entry's file is in `fixed`
 * and the prompt does not say the file is unchanged, as a real model would
 * with the changed code in front of it. Everything else stays open. */
function closingFixed(fixed: string[]): (prompt: string) => Answer {
  return (prompt) => ({
    findings: [],
    previousFindings: [
      ...prompt.matchAll(/^(F\d+) · ([^\n]*?) · (\S+?):\d+/gm),
    ].map((m) => ({
      id: m[1]!,
      state:
        !m[2]!.startsWith("file unchanged") && fixed.includes(m[3]!)
          ? ("closed" as const)
          : ("open" as const),
    })),
  });
}

test("a fix is judged after a run that did not show its file", async () => {
  await writeGuide("# Guide\n\nValidate values.\n");
  const A_FIXED = ["const a = validate(read())", "use(a.value)", "done()"];
  const B_FIXED = ["const b = validate(read())", "use(b.value)", "done()"];

  // Run 1: two new findings.
  const r1 = await run(
    {
      head: "sha1",
      files: [file("a.ts", A_LINES), file("b.ts", B_LINES)],
      compare: "ahead",
    },
    scriptedModel(FIRST).ai,
  );
  if (summaryCounts(r1.resolved).new !== 2) throw new Error("run 1");

  // Run 2: the same head again. Nothing is shown to the model.
  const r2 = await run(
    {
      head: "sha1",
      files: [file("a.ts", A_LINES), file("b.ts", B_LINES)],
      compare: "ahead",
    },
    scriptedModel(closingFixed([])).ai,
  );
  if (summaryCounts(r2.resolved).open !== 2) {
    throw new Error(`run 2: ${JSON.stringify(states(r2.resolved))}`);
  }

  // Run 3: the author fixes a.ts. The model sees it and closes it.
  const model3 = scriptedModel(closingFixed(["a.ts"]));
  const r3 = await run(
    {
      head: "sha2",
      files: [file("a.ts", A_FIXED), file("b.ts", B_LINES)],
      compare: "ahead",
    },
    model3.ai,
  );
  if (states(r3.resolved)["a.ts"] !== "closed") {
    throw new Error(`run 3: ${JSON.stringify(states(r3.resolved))}`);
  }
  if (states(r3.resolved)["b.ts"] !== "open") throw new Error("run 3 b.ts");

  // Run 4: the author fixes b.ts. a.ts is unchanged and already closed.
  const r4 = await run(
    {
      head: "sha3",
      files: [file("a.ts", A_FIXED), file("b.ts", B_FIXED)],
      compare: "ahead",
    },
    scriptedModel(closingFixed(["b.ts"])).ai,
  );
  const got = states(r4.resolved);
  if (got["b.ts"] !== "closed") {
    throw new Error(`run 4: ${JSON.stringify(got)}`);
  }
  if (summaryCounts(r4.resolved).open !== 0) {
    throw new Error(`run 4 left a finding open: ${JSON.stringify(got)}`);
  }
});

test("a same-head re-run carries every finding and does not compare", async () => {
  await writeGuide("# Guide\n\nValidate values.\n");
  const files = [file("a.ts", A_LINES), file("b.ts", B_LINES)];
  await run({ head: "sha1", files, compare: "ahead" }, scriptedModel(FIRST).ai);
  // `throws` proves the same head is decided without asking GitHub.
  const model = scriptedModel(closingFixed([]));
  const { resolved } = await run(
    { head: "sha1", files, compare: "throws" },
    model.ai,
  );
  const counts = summaryCounts(resolved);
  if (counts.open !== 2 || counts.new !== 0 || counts.closed !== 0) {
    throw new Error(JSON.stringify(counts));
  }
  if (!/UNCHANGED SINCE LAST REVIEW/.test(model.prompts[0] ?? "")) {
    throw new Error("the files were not listed as unchanged");
  }
});

test("a head GitHub calls identical keeps the carry-over", async () => {
  const result = await secondRunWithRestart(async () => {}, {
    ...SECOND_PUSH,
    compare: "identical",
  });
  if (!/PREVIOUS FINDINGS/.test(result.prompt)) {
    throw new Error("an identical head dropped the carry-over");
  }
});

test("a head behind the last reviewed head starts fresh", async () => {
  const result = await secondRunWithRestart(async () => {}, {
    ...SECOND_PUSH,
    compare: "behind",
  });
  assertFresh(result);
});

test("a failed compare says so in the log, not that the head was rewritten", async () => {
  await writeGuide("# Guide\n\nValidate values.\n");
  const files = [file("a.ts", A_LINES), file("b.ts", B_LINES)];
  await run({ head: "sha1", files, compare: "ahead" }, scriptedModel(FIRST).ai);
  const lines: string[] = [];
  await startPrCarry(
    fakeGithub({ head: "sha2", files, compare: "throws" }),
    await options(),
    false,
    (line) => lines.push(line),
  );
  const said = lines.join("\n");
  if (!/could not compare/i.test(said) || !/HTTP 404/.test(said)) {
    throw new Error(`log: ${said}`);
  }
  if (/does not contain/i.test(said)) {
    throw new Error(`the log blames a force-push: ${said}`);
  }
});

test("a force-push says so in the log", async () => {
  await writeGuide("# Guide\n\nValidate values.\n");
  const files = [file("a.ts", A_LINES), file("b.ts", B_LINES)];
  await run({ head: "sha1", files, compare: "ahead" }, scriptedModel(FIRST).ai);
  const lines: string[] = [];
  await startPrCarry(
    fakeGithub({ head: "sha2", files, compare: "diverged" }),
    await options(),
    false,
    (line) => lines.push(line),
  );
  if (!/does not contain/i.test(lines.join("\n"))) {
    throw new Error(`log: ${lines.join("\n")}`);
  }
});

test("pull request runs are keyed by number", async () => {
  await writeGuide("# Guide\n\nValidate values.\n");
  await run(
    {
      head: "sha1",
      files: [file("a.ts", A_LINES)],
      compare: "ahead",
    },
    scriptedModel(() => ({ findings: [] })).ai,
  );
  const raw = await cacheGet("local-review", prSubjectId(REPO, 7));
  if (!raw) throw new Error("the pull request snapshot is not under its key");
  const other = await cacheGet("local-review", prSubjectId(REPO, 8));
  if (other) throw new Error("pull request 8 shares pull request 7's key");
});

/** A GitHub that keeps every endpoint it was asked for. */
function loggedGithub(state: Pull): { client: GitHubClient; asked: string[] } {
  const inner = fakeGithub(state);
  const asked: string[] = [];
  return {
    asked,
    client: {
      request: (endpoint) => {
        asked.push(endpoint);
        return inner.request(endpoint);
      },
      pages: (endpoint, limit, progress) => {
        asked.push(endpoint);
        return inner.pages(endpoint, limit, progress);
      },
    },
  };
}

const isPullRead = (endpoint: string) =>
  endpoint.endsWith("/pulls/7") || endpoint.endsWith("/pulls/7/files");

test("with the pull request and its files given, the review does not read them again", async () => {
  await writeGuide("# Guide\n\nValidate values.\n");
  const state: Pull = {
    head: "sha1",
    files: [file("a.ts", A_LINES)],
    compare: "ahead",
  };
  const { client, asked } = loggedGithub(state);
  const carry = await startPrCarry(client, await options(), false);
  const afterCarry = asked.filter(isPullRead).length;
  await reviewPullRequest(
    client,
    await options(),
    undefined,
    undefined,
    scriptedModel(() => ({ findings: [] })).ai,
    undefined,
    carry.extras,
  );
  if (afterCarry !== 2) throw new Error(`carry read ${afterCarry}`);
  const total = asked.filter(isPullRead);
  if (total.length !== 2) {
    throw new Error(`the pull request was read again: ${total.join(", ")}`);
  }
});

test("without them the review reads the pull request and its files itself", async () => {
  await writeGuide("# Guide\n\nValidate values.\n");
  const { client, asked } = loggedGithub({
    head: "sha1",
    files: [file("a.ts", A_LINES)],
    compare: "ahead",
  });
  await reviewPullRequest(
    client,
    await options(),
    undefined,
    undefined,
    scriptedModel(() => ({ findings: [] })).ai,
  );
  const reads = asked.filter(isPullRead).sort();
  if (reads.length !== 2 || !reads[0]!.endsWith("/pulls/7")) {
    throw new Error(`reads: ${reads.join(", ")}`);
  }
});
