/** Commit watch pieces that need no server: the words written to GitHub,
 * finding a tracked finding's code again, the comment classifier's answer,
 * the maintainer notes a sync writes, the push webhook and `queuePush`, and
 * the `--range` flags. The whole flow runs in `scripts/commit_watch_smoke.ts`. */
import { test } from "node:test";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import {
  activateRepo,
  markKnowledgeBuilt,
  updateRepoSettings,
} from "../store/repos.ts";
import { getJob, listJobs } from "../store/jobs.ts";
import { getReview } from "../store/reviews.ts";
import {
  getPushEvent,
  insertWatchIssue,
  insertWatchNote,
  listWatchIssues,
  pushSources,
} from "../store/watch.ts";
import { dispatchGithubEvent } from "./webhook.ts";
import { queuePush, registerPushReviewHandlers } from "./push_review.ts";
import { claimAndRun } from "./jobs.ts";
import { getPushResult } from "../store/watch.ts";
import { writeUserConfig } from "../config.ts";
import {
  changedLines,
  closedStillFoundComment,
  findingSummary,
  fixedComment,
  issueBody,
  issueTitle,
  locateAnchor,
  pushRange,
  stillFoundComment,
} from "./watch_issues.ts";
import { parseClassification } from "./watch_comments.ts";
import { applyWatchNotes, withMaintainerNotes } from "./watch_notes.ts";
import { FakeAiProvider } from "../ai/fake.ts";
import { parseReviewArgs } from "../cli/review_args.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { isolateTestFile } from "../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

const BEFORE = "1".repeat(40);
const AFTER = "2".repeat(40);
const LATER = "3".repeat(40);

async function withTempDb(fn: () => Promise<void> | void): Promise<void> {
  const original = getEnv("CM_APP_DB");
  const originalConfig = getEnv("CM_CONFIG_PATH");
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
  setEnv("CM_CONFIG_PATH", `${tempDirSync()}/config.json`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
    if (originalConfig === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", originalConfig);
  }
}

function expect(ok: unknown, message: string): void {
  if (!ok) throw new Error(message);
}

test("the comments name the push review, never the latest one", () => {
  const range = pushRange(BEFORE, AFTER);
  expect(range === "1111111..2222222", range);
  expect(
    stillFoundComment(AFTER, AFTER, range) ===
      "change in 2222222: changed, still found by the review of 1111111..2222222",
    "one hash when the commit is the push",
  );
  expect(
    stillFoundComment(LATER, AFTER, range) ===
      "change in 3333333 (push 2222222): changed, still found by the review of 1111111..2222222",
    "both hashes when they differ",
  );
  expect(
    fixedComment(AFTER, range) ===
      "change in 2222222: changed, no longer found by the review of 1111111..2222222. Closing.",
    "fixed",
  );
  expect(
    closedStillFoundComment(range).startsWith(
      "This issue was closed, but the review of push 1111111..2222222 still finds the problem.",
    ),
    "closed but still found",
  );
  for (const text of [
    stillFoundComment(AFTER, AFTER, range),
    fixedComment(AFTER, range),
    closedStillFoundComment(range),
  ]) {
    expect(!/latest/i.test(text), `says latest: ${text}`);
  }
});

test("an issue: severity in the title, labels apart, the push and a permalink in the body", () => {
  const summary = findingSummary(
    "[P1 · blocking] `src/a.ts`: `pay()`",
    "Refunds pay twice.\n\nThe amount is doubled.",
  );
  expect(summary === "Refunds pay twice.", summary);
  expect(issueTitle("P1", summary) === "[P1] Refunds pay twice.", "title");
  expect(
    findingSummary("[P0 · blocking] `src/a.ts`: `pay()`", "") ===
      "src/a.ts: pay()",
    "falls back to the heading",
  );
  const body = issueBody({
    id: "f-1",
    body: "Refunds pay twice.\n\n```suggestion\nreturn amount;\n```",
    repo: "acme/widgets",
    after: AFTER,
    before: BEFORE,
    branch: "main",
    path: "src/a.ts",
    lineFrom: 4,
    lineTo: 6,
  });
  expect(
    body.includes(
      `https://github.com/acme/widgets/blob/${AFTER}/src/a.ts#L4-L6`,
    ),
    "permalink",
  );
  expect(body.includes("**Push:** `1111111..2222222` on `main`"), "push");
  expect(
    body.includes("Feel free to ask questions here if you need more detail."),
    "questions",
  );
  expect(
    body.includes("Opened by co-maintainer commit watch review."),
    "footer",
  );
  expect(body.endsWith("<!-- co-maintainer:finding f-1 -->"), "marker");
  expect(!body.includes("suggestion"), "a suggestion block reached the issue");
});

test("a tracked finding is found again by its code, the nearest match first", () => {
  const content = "a\n\nconst x = 1;\nreturn x;\n\nconst x = 1;\nreturn x;\n";
  const near = locateAnchor(content, "const x = 1;\nreturn x;", 6);
  expect(near?.from === 6 && near.to === 7, JSON.stringify(near));
  const blank = locateAnchor(content, "  const   x = 1;\n\nreturn x;", 1);
  expect(
    blank?.from === 3 && blank.to === 4,
    `whitespace and blank lines: ${JSON.stringify(blank)}`,
  );
  expect(locateAnchor(content, "gone();", 1) === undefined, "missing code");
});

test("changed lines are the added lines and the place of a removed one", () => {
  const patch = "@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n-d\n";
  const lines = changedLines(patch);
  expect(lines.has(2), "the replaced line");
  expect(lines.has(4), "where the removed line was");
  expect(!lines.has(1) && !lines.has(3), [...lines].join(","));
});

test("the classifier's answer: anything unreadable means not for us", () => {
  expect(
    parseClassification('{"forUs": true, "kind": "ignore"}').kind === "ignore",
    "ignore",
  );
  const fenced = parseClassification(
    '```json\n{"forUs": true, "kind": "question"}\n```',
  );
  expect(fenced.forUs && fenced.kind === "question", "fenced json");
  expect(!parseClassification("sure!").forUs, "prose");
  expect(
    parseClassification('{"forUs": true, "kind": "shout"}').kind === "other",
    "unknown kind",
  );
  expect(
    !parseClassification('{"forUs": "yes", "kind": "ignore"}').forUs,
    "forUs must be true",
  );
});

test("maintainer notes replace the last section and leave the guide alone", () => {
  const once = withMaintainerNotes("# Guide\n\n- rule\n", [
    "Loops in src/net are intended.",
  ]);
  expect(
    once.startsWith(
      "# Guide\n\n- rule\n\n<!-- co-maintainer:maintainer-notes -->",
    ),
    once,
  );
  const twice = withMaintainerNotes(once, ["A.", "B."]);
  expect(
    twice.split("co-maintainer:maintainer-notes").length === 2,
    "the section doubled",
  );
  expect(twice.includes("- A.\n- B.") && !twice.includes("Loops"), twice);
  expect(
    withMaintainerNotes("", ["A."]).startsWith("# Review notes"),
    "no guide yet",
  );
  expect(
    withMaintainerNotes(once, []) === "# Guide\n\n- rule\n",
    "no notes left",
  );
});

test("sync applies each note once, and ignore marks the issue ignored", async () => {
  await withTempDb(async () => {
    activateRepo("acme/widgets", 1);
    const issue = insertWatchIssue({
      repo: "acme/widgets",
      issueNumber: 7,
      severity: "P1",
      title: "Retries never stop.",
      bodyMd: "Retries never stop.",
      path: "src/net/retry.ts",
      lineFrom: 2,
      lineTo: 2,
      anchorText: "while (true) await fn();",
      reviewId: "r-1",
    });
    insertWatchNote({
      repo: "acme/widgets",
      issueNumber: 7,
      commentId: "c-1",
      author: "owner",
      kind: "ignore",
      body: "@co-maintainer this is intended",
    });
    expect(
      !insertWatchNote({
        repo: "acme/widgets",
        issueNumber: 7,
        commentId: "c-1",
        author: "owner",
        kind: "ignore",
        body: "again",
      }),
      "the same comment was stored twice",
    );
    let calls = 0;
    const ai = new FakeAiProvider("Retry loops in src/net are intended.");
    const counting = {
      complete: async (request: Parameters<FakeAiProvider["complete"]>[0]) => {
        calls++;
        return await ai.complete(request);
      },
    };
    const lines = await applyWatchNotes("acme/widgets", counting);
    expect(
      lines[0] ===
        "Retry loops in src/net are intended. (about `src/net/retry.ts`)",
      lines.join("|"),
    );
    expect(
      listWatchIssues("acme/widgets").find((i) => i.id === issue.id)?.state ===
        "ignored",
      "not ignored",
    );
    const again = await applyWatchNotes("acme/widgets", counting);
    expect(calls === 1, `the low model ran ${calls} times for one note`);
    expect(again.length === 1, "a later sync dropped the note from the guide");
  });
});

function pushPayload(ref = "refs/heads/main", after = AFTER) {
  return {
    ref,
    before: BEFORE,
    after,
    repository: { full_name: "acme/widgets", default_branch: "main" },
    installation: { id: 1 },
  };
}

test("the push webhook reviews the default branch only", async () => {
  await withTempDb(() => {
    activateRepo("acme/widgets", 1);
    markKnowledgeBuilt("acme/widgets", "abc");
    const other = dispatchGithubEvent(
      "push",
      pushPayload("refs/heads/feature"),
      "d-1",
    );
    expect(other.outcome === "ignored", `feature branch: ${other.outcome}`);
    const tag = dispatchGithubEvent("push", pushPayload("refs/tags/v1"), "d-2");
    expect(tag.outcome === "ignored", "tag");
    const deleted = dispatchGithubEvent(
      "push",
      { ...pushPayload(), after: "0".repeat(40), deleted: true },
      "d-3",
    );
    expect(deleted.outcome === "ignored", "deleted branch");
    const main = dispatchGithubEvent("push", pushPayload(), "d-4");
    expect(main.outcome === "enqueued" && main.jobId, `main: ${main.outcome}`);
    const job = getJob(main.jobId!);
    expect(job?.type === "push_review", job?.type ?? "no job");
    const again = dispatchGithubEvent("push", pushPayload(), "d-5");
    expect(
      again.outcome === "skipped" && again.reason === "already-reviewed",
      `duplicate: ${again.reason}`,
    );
  });
});

test("App and CI on the same push share one review, and CI attaches to it", async () => {
  await withTempDb(() => {
    activateRepo("acme/widgets", 1);
    markKnowledgeBuilt("acme/widgets", "abc");
    const app = queuePush({
      repo: "acme/widgets",
      before: BEFORE,
      after: AFTER,
      ref: "refs/heads/main",
      source: "app",
    });
    expect(app.kind === "enqueued", app.kind);
    const ci = queuePush({
      repo: "acme/widgets",
      before: BEFORE,
      after: AFTER,
      ref: "refs/heads/main",
      source: "ci",
    });
    expect(ci.kind === "attached", ci.kind);
    if (app.kind === "enqueued" && ci.kind === "attached") {
      expect(app.jobId === ci.jobId, "two jobs for one push");
    }
    const sources = pushSources(getPushEvent("acme/widgets", AFTER)!);
    expect(
      sources.includes("app") && sources.includes("ci"),
      sources.join(","),
    );
    expect(
      listJobs({ repo: "acme/widgets" }).filter((j) => j.type === "push_review")
        .length === 1,
      "jobs",
    );
  });
});

test("a new branch has nothing to review, and an uninitialized repository gets no review", async () => {
  await withTempDb(() => {
    activateRepo("acme/widgets", null as unknown as number);
    const created = queuePush({
      repo: "acme/widgets",
      before: "0".repeat(40),
      after: AFTER,
      ref: "refs/heads/main",
      source: "ci",
    });
    expect(created.kind === "no_changes", created.kind);
    const fresh = queuePush({
      repo: "acme/widgets",
      before: BEFORE,
      after: AFTER,
      ref: "refs/heads/main",
      source: "ci",
    });
    expect(
      fresh.kind === "skipped" &&
        fresh.reason === "not-initialized" &&
        !fresh.checkRun,
      JSON.stringify(fresh),
    );
    expect(listJobs({ repo: "acme/widgets" }).length === 0, "a job was queued");
  });
});

test("cancel-and-merge folds a waiting push into the next, from the oldest before", async () => {
  await withTempDb(() => {
    activateRepo("acme/widgets", null as unknown as number);
    markKnowledgeBuilt("acme/widgets", "abc");
    updateRepoSettings("acme/widgets", { watch_push_mode: "cancel-and-merge" });
    const first = queuePush({
      repo: "acme/widgets",
      before: BEFORE,
      after: AFTER,
      ref: "refs/heads/main",
      source: "app",
    });
    // The App path builds the merged diff itself, so it never asks to extend.
    const second = queuePush({
      repo: "acme/widgets",
      before: AFTER,
      after: LATER,
      ref: "refs/heads/main",
      source: "app",
    });
    if (first.kind !== "enqueued" || second.kind !== "enqueued")
      throw new Error("not enqueued");
    expect(
      getJob(first.jobId)?.status === "canceled",
      "the waiting push was not canceled",
    );
    expect(getJob(first.jobId)?.cancel_reason === "merged", "cancel reason");
    expect(
      getReview(second.reviewId)?.base_sha === BEFORE,
      "the merged review does not start at the oldest before",
    );
    expect(
      getPushEvent("acme/widgets", AFTER)?.job_id === second.jobId,
      "the folded push does not point at the merged review",
    );
  });
});

test("cancel-and-merge asks a CI step for the wider diff when no App can build it", async () => {
  await withTempDb(() => {
    activateRepo("acme/widgets", null as unknown as number);
    markKnowledgeBuilt("acme/widgets", "abc");
    updateRepoSettings("acme/widgets", { watch_push_mode: "cancel-and-merge" });
    const revision = {
      files: [],
      title: "",
      description: "",
      baseLabel: "main",
      producer: "remote" as const,
    };
    queuePush({
      repo: "acme/widgets",
      before: BEFORE,
      after: AFTER,
      ref: "refs/heads/main",
      source: "ci",
      revision,
    });
    const narrow = queuePush({
      repo: "acme/widgets",
      before: AFTER,
      after: LATER,
      ref: "refs/heads/main",
      source: "ci",
      revision,
    });
    expect(
      narrow.kind === "extend" && narrow.before === BEFORE,
      JSON.stringify(narrow),
    );
    const wide = queuePush({
      repo: "acme/widgets",
      before: BEFORE,
      after: LATER,
      ref: "refs/heads/main",
      source: "ci",
      revision,
    });
    expect(wide.kind === "enqueued", wide.kind);
  });
});

test("--range needs --remote, and --timeout-minutes needs --range", async () => {
  const ok = await parseReviewArgs([
    "--remote",
    `--range=${BEFORE}..${AFTER}`,
    "--timeout-minutes=15",
  ]);
  expect(
    ok.mode === "remote" &&
      ok.range?.before === BEFORE &&
      ok.range.after === AFTER,
    "range",
  );
  expect(ok.timeoutMinutes === 15, "timeout");
  for (const range of ["v0.6.9..v0.6.10", "release/1.2..HEAD"]) {
    const dotted = await parseReviewArgs(["--remote", `--range=${range}`]);
    expect(
      dotted.mode === "remote" &&
        `${dotted.range?.before}..${dotted.range?.after}` === range,
      `dotted ${range}`,
    );
  }
  for (const args of [
    ["--remote", "--range=a...b"],
    ["--remote", "--range=a..-b"],
    [`--range=${BEFORE}..${AFTER}`],
    ["--remote", "--timeout-minutes=5"],
    ["--remote", "--range=abc"],
    ["--remote", "--range=--help..x"],
    ["--remote", `--range=${BEFORE}..${AFTER}`, "--timeout-minutes=0"],
    ["--remote", `--range=${BEFORE}..${AFTER}`, "--fresh"],
  ]) {
    let refused = false;
    try {
      await parseReviewArgs(args);
    } catch {
      refused = true;
    }
    expect(refused, `accepted: ${args.join(" ")}`);
  }
});

test("a push review result carries the coverage and warnings of its diff plan", async () => {
  const repos = tempDirSync();
  const originals = new Map(
    ["CM_FAKE_AI", "CM_REPOS_DIR"].map((name) => [name, getEnv(name)]),
  );
  setEnv("CM_FAKE_AI", "1");
  setEnv("CM_REPOS_DIR", repos);
  try {
    await withTempDb(async () => {
      await writeUserConfig({
        ai: "openrouter",
        token: "key",
        lowModel: "fake/model",
        highModel: "fake/model",
      });
      activateRepo("acme/widgets", null as unknown as number);
      markKnowledgeBuilt("acme/widgets", "abc");
      await mkdirPath(`${repos}/acme/widgets`, { recursive: true });
      await writeTextFile(
        `${repos}/acme/widgets/PR_REVIEW_GUIDE.md`,
        "# Guide\n",
      );
      const big = Array.from({ length: 600 }, (_, i) => `+const v${i} = ${i};`);
      const queued = queuePush({
        repo: "acme/widgets",
        before: BEFORE,
        after: AFTER,
        ref: "refs/heads/main",
        source: "ci",
        revision: {
          title: "",
          description: "",
          baseLabel: "main",
          producer: "remote",
          files: [
            {
              path: "src/big.ts",
              previousPath: null,
              status: "added",
              binary: false,
              additions: 600,
              deletions: 0,
              patch: `@@ -0,0 +1,600 @@\n${big.join("\n")}`,
            },
            {
              path: "src/small.ts",
              previousPath: null,
              status: "added",
              binary: false,
              additions: 1,
              deletions: 0,
              patch: "@@ -0,0 +1 @@\n+export const a = 1;",
            },
          ],
        },
      });
      if (queued.kind !== "enqueued") throw new Error(queued.kind);
      registerPushReviewHandlers();
      expect(await claimAndRun(), "the push review never ran");
      const result = getPushResult(queued.reviewId) as {
        revision?: {
          files: number;
          truncated: boolean;
          coverage: { full: number; summarized: string[] };
        };
        warnings?: unknown[];
      };
      expect(result, `no result: ${getReview(queued.reviewId)?.status}`);
      expect(result.revision?.files === 2, JSON.stringify(result.revision));
      expect(result.revision?.truncated === true, "truncated");
      expect(
        JSON.stringify(result.revision?.coverage.summarized) ===
          JSON.stringify(["src/big.ts"]),
        JSON.stringify(result.revision?.coverage),
      );
      expect(result.revision?.coverage.full === 1, "the small file is full");
      expect(Array.isArray(result.warnings), "warnings key");
    });
  } finally {
    for (const [name, value] of originals) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
  }
});
