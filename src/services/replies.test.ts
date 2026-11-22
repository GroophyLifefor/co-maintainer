import { closeAppDb, getAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo } from "../store/repos.ts";
import {
  createReplyRequestAndJob,
  getReplyRequest,
  setReplyStatus,
} from "../store/replies.ts";
import { getJob } from "../store/jobs.ts";
import {
  findingRules,
  runReplyJob,
  takeCloseLine,
  takeWithdrawLine,
} from "./replies.ts";
import { listAudit } from "../store/audit.ts";
import { insertReview } from "../store/reviews.ts";
import {
  insertFinding,
  listFindingsForPr,
  setFindingPosted,
} from "../store/findings.ts";
import { cacheValues } from "../store/cache_db.ts";
import type { AiProvider, GitHubClient, Json } from "../types.ts";
import type { JobRow } from "../store/rows.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { test } from "node:test";
import { isolateTestFile } from "../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

async function withEnv(fn: () => Promise<void>): Promise<void> {
  const originalDb = getEnv("CM_APP_DB");
  const originalRepos = getEnv("CM_REPOS_DIR");
  // A reply records its AI cost in cache.db. Keep it out of the real cache:
  // the cache directory comes from XDG_CACHE_HOME on Linux, LOCALAPPDATA on
  // Windows and HOME on macOS.
  const cacheKeys = ["XDG_CACHE_HOME", "LOCALAPPDATA", "HOME", "USERPROFILE"];
  const originalCache = cacheKeys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  for (const key of cacheKeys) setEnv(key, `${dir}/cache`);
  await mkdirPath(`${dir}/repos/acme/widgets`, { recursive: true });
  await writeTextFile(
    `${dir}/repos/acme/widgets/PR_REVIEW_GUIDE.md`,
    "Answer review questions from the supplied code.",
  );
  try {
    await openAppDb();
    activateRepo("acme/widgets", 7);
    await fn();
  } finally {
    await closeAppDb();
    if (originalDb === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", originalDb);
    if (originalRepos === undefined) deleteEnv("CM_REPOS_DIR");
    else setEnv("CM_REPOS_DIR", originalRepos);
    cacheKeys.forEach((key, index) => {
      const value = originalCache[index];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    });
  }
}

class FakeGithub implements GitHubClient {
  writes: { endpoint: string; body: unknown }[] = [];
  existingReply?: Json;

  request<T>(endpoint: string): Promise<T> {
    if (endpoint.includes("/pulls/1")) {
      return Promise.resolve({
        number: 1,
        title: "Change",
        body: "Please review this change.",
        head: { sha: "head1" },
      } as T);
    }
    throw new Error(`unexpected request ${endpoint}`);
  }

  pages<T>(endpoint: string): Promise<T[]> {
    if (endpoint.includes("/pulls/1/comments")) {
      return Promise.resolve([
        {
          id: 10,
          body: "The original finding.",
          path: "src/app.ts",
          line: 4,
          user: { login: "co-maintainer-beta[bot]", type: "Bot" },
        },
      ] as T[]);
    }
    if (endpoint.includes("/issues/1/comments")) {
      return Promise.resolve(
        (this.existingReply ? [this.existingReply] : []) as T[],
      );
    }
    return Promise.resolve([] as T[]);
  }

  write<T>(endpoint: string, body: unknown): Promise<T> {
    this.writes.push({ endpoint, body });
    return Promise.resolve({ id: 900 } as T);
  }
}

function replyAi(text: string): AiProvider {
  return {
    complete: () =>
      Promise.resolve({
        text,
        tokensIn: 1,
        tokensOut: 1,
        model: "fake",
        provider: "openrouter",
      }),
  };
}

function requestJob(
  sourceKind: "review_comment" | "issue_comment",
  sourceCommentId: string,
  targetCommentId?: string,
  extra: { mayClose?: boolean; sourceBody?: string } = {},
): JobRow {
  const result = createReplyRequestAndJob({
    repo: "acme/widgets",
    prNumber: 1,
    sourceKind,
    sourceCommentId,
    targetCommentId,
    sourceBody: extra.sourceBody ?? "Can you explain this?",
    sourceAuthor: "octocat",
    mayClose: extra.mayClose,
  });
  return getJob(result.request.job_id!)!;
}

test("reply jobs post inline replies to the stored thread target", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const job = requestJob("review_comment", "101", "10");
    await runReplyJob(
      job,
      () => {},
      github,
      replyAi("The finding blocks the unsafe branch."),
    );
    const posted = github.writes[0];
    if (!posted.endpoint.endsWith("/pulls/1/comments")) {
      throw new Error(`unexpected endpoint ${posted.endpoint}`);
    }
    const body = posted.body as { body: string; in_reply_to: number };
    if (body.in_reply_to !== 10 || !body.body.includes("unsafe branch")) {
      throw new Error(`unexpected reply ${JSON.stringify(body)}`);
    }
    if (getReplyRequest("reply-missing") !== undefined) {
      throw new Error("unexpected reply row");
    }
  });
});

test("the same source comment creates only one reply request", async () => {
  await withEnv(async () => {
    const first = createReplyRequestAndJob({
      repo: "acme/widgets",
      prNumber: 1,
      sourceKind: "issue_comment",
      sourceCommentId: "105",
      sourceBody: "First delivery.",
    });
    const second = createReplyRequestAndJob({
      repo: "acme/widgets",
      prNumber: 1,
      sourceKind: "issue_comment",
      sourceCommentId: "105",
      sourceBody: "Duplicate delivery.",
    });
    if (second.created || first.request.id !== second.request.id) {
      throw new Error("source comment was not deduplicated");
    }
  });
});

test("reply jobs use issue comments for explicit PR mentions", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const job = requestJob("issue_comment", "102");
    await runReplyJob(
      job,
      () => {},
      github,
      replyAi("The review is based on the current branch behavior."),
    );
    if (!github.writes[0].endpoint.endsWith("/issues/1/comments")) {
      throw new Error(`unexpected endpoint ${github.writes[0].endpoint}`);
    }
  });
});

test("a persisted answer is posted without calling the AI again", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const job = requestJob("issue_comment", "103");
    const args = JSON.parse(job.args) as { requestId: string };
    setReplyStatus(args.requestId, "ready", { answer_md: "Persisted answer." });
    const ai: AiProvider = {
      complete: () => Promise.reject(new Error("AI should not run")),
    };
    await runReplyJob(job, () => {}, github, ai);
    const body = (github.writes[0].body as Json).body;
    if (typeof body !== "string" || !body.includes("Persisted answer.")) {
      throw new Error(`persisted answer was not posted: ${String(body)}`);
    }
  });
});

test("a reply records its AI cost once, and a rerun with the answer saved records none", async () => {
  await withEnv(async () => {
    const job = requestJob("review_comment", "106", "10");
    const ai: AiProvider = {
      complete: () =>
        Promise.resolve({
          text: "The finding blocks the unsafe branch.",
          tokensIn: 1207,
          tokensOut: 17,
          cost: 0.0004,
          model: "fake",
          provider: "openrouter",
        }),
    };
    await runReplyJob(job, () => {}, new FakeGithub(), ai);
    // The same job again: the answer is saved, so nothing is asked or paid.
    await runReplyJob(job, () => {}, new FakeGithub(), ai);
    const rows = (await cacheValues("cost", "acme/widgets:")).map(
      (value) =>
        JSON.parse(value) as { job: string; tokensIn: number; usd: number },
    );
    if (
      rows.length !== 1 ||
      rows[0]!.job !== "reply_to_github_comment" ||
      rows[0]!.tokensIn !== 1207 ||
      rows[0]!.usd !== 0.0004
    ) {
      throw new Error(`cost rows: ${JSON.stringify(rows)}`);
    }
  });
});

test("a reply already accepted by GitHub is reconciled by its marker", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const result = createReplyRequestAndJob({
      repo: "acme/widgets",
      prNumber: 1,
      sourceKind: "issue_comment",
      sourceCommentId: "104",
      sourceBody: "Please clarify.",
    });
    setReplyStatus(result.request.id, "posting", {
      answer_md: "Already generated.",
    });
    github.existingReply = {
      id: 901,
      body: `<!-- co-maintainer:reply:${result.request.id} -->\nAlready generated.`,
    };
    await runReplyJob(
      getJob(result.request.job_id!)!,
      () => {},
      github,
      replyAi("Should not run."),
    );
    if (github.writes.length !== 0) {
      throw new Error("reconciliation posted a duplicate reply");
    }
    if (getReplyRequest(result.request.id)?.status !== "posted") {
      throw new Error("reply marker was not reconciled");
    }
  });
});

/** A review of pull request 1 with one finding posted as comment 10. */
function postedFinding(jobId: string): string {
  const reviewId = crypto.randomUUID();
  insertReview({
    id: reviewId,
    repo: "acme/widgets",
    prNumber: 1,
    jobId,
    headSha: "head1",
    baseSha: "base1",
    scope: "full",
    model: "fake",
  });
  const findingId = crypto.randomUUID();
  insertFinding({
    id: findingId,
    reviewId,
    severity: "P2",
    path: "src/app.ts",
    lineFrom: 4,
    lineTo: 4,
    title: "[P2 · non-blocking] `src/app.ts`: `run()`",
    bodyMd: "The original finding.",
    state: "new",
  });
  setFindingPosted(findingId, "10");
  return findingId;
}

test("a reply that agrees the finding was wrong withdraws it and never posts the marker line", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const job = requestJob("review_comment", "107", "10");
    const findingId = postedFinding(job.id);
    await runReplyJob(
      job,
      () => {},
      github,
      replyAi("Agreed, the finding is incorrect.\n\nWITHDRAWN\n"),
    );
    const body = (github.writes[0]!.body as { body: string }).body;
    if (body.includes("WITHDRAWN") || !body.includes("finding is incorrect")) {
      throw new Error(`posted body: ${body}`);
    }
    const row = listFindingsForPr("acme/widgets", 1).find(
      (item) => item.id === findingId,
    );
    if (row?.state !== "closed" || row.close_reason !== "withdrawn") {
      throw new Error(`finding is ${row?.state}/${row?.close_reason}`);
    }
  });
});

test("a reply that defends the finding leaves it open", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const job = requestJob("review_comment", "108", "10");
    const findingId = postedFinding(job.id);
    await runReplyJob(
      job,
      () => {},
      github,
      replyAi("The finding stands: the branch is still unsafe."),
    );
    const row = listFindingsForPr("acme/widgets", 1).find(
      (item) => item.id === findingId,
    );
    if (row?.state !== "new") throw new Error(`finding is ${row?.state}`);
  });
});

/** The AI request's system text, kept so a test can read the rules. */
function capturingAi(text: string, seen: string[]): AiProvider {
  return {
    complete: (request) => {
      seen.push(String(request.system ?? ""));
      return Promise.resolve({
        text,
        tokensIn: 1,
        tokensOut: 1,
        model: "fake",
        provider: "openrouter",
      });
    },
  };
}

const CLOSING_ANSWER =
  "Closed it. I still read it the other way, but you know this code better. What was the problem with the finding?\n\nCLOSED\n";

test("a maintainer asking to close a finding closes it, the reply asks for feedback and never posts the marker", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const job = requestJob("review_comment", "120", "10", {
      mayClose: true,
      sourceBody: "This finding is wrong, close it.",
    });
    const findingId = postedFinding(job.id);
    const seen: string[] = [];
    await runReplyJob(job, () => {}, github, capturingAi(CLOSING_ANSWER, seen));
    if (!seen[0]?.includes("close it, even if you still think it is right")) {
      throw new Error("the close rule was not asked");
    }
    const body = (github.writes[0]!.body as { body: string }).body;
    if (body.includes("CLOSED") || !body.includes("What was the problem")) {
      throw new Error(`posted body: ${body}`);
    }
    const row = listFindingsForPr("acme/widgets", 1).find(
      (item) => item.id === findingId,
    );
    if (row?.state !== "closed" || row.close_reason !== "dismissed") {
      throw new Error(`finding is ${row?.state}/${row?.close_reason}`);
    }
  });
});

test("someone who may not dismiss cannot close a finding by asking, whatever the model answers", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const job = requestJob("review_comment", "121", "10", {
      sourceBody: "Close this finding.",
    });
    const findingId = postedFinding(job.id);
    const seen: string[] = [];
    await runReplyJob(job, () => {}, github, capturingAi(CLOSING_ANSWER, seen));
    if (!seen[0]?.includes("a maintainer can close it")) {
      throw new Error("the maintainer rule was not asked");
    }
    const body = (github.writes[0]!.body as { body: string }).body;
    if (body.includes("CLOSED")) throw new Error(`posted body: ${body}`);
    const row = listFindingsForPr("acme/widgets", 1).find(
      (item) => item.id === findingId,
    );
    if (row?.state !== "new") throw new Error(`finding is ${row?.state}`);
  });
});

test("a reply on a closed finding is kept in the audit log as feedback", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const first = requestJob("review_comment", "122", "10", {
      mayClose: true,
      sourceBody: "Close it.",
    });
    postedFinding(first.id);
    await runReplyJob(first, () => {}, github, replyAi(CLOSING_ANSWER));
    const second = requestJob("review_comment", "123", "10", {
      sourceBody: "The value is checked by the caller before this runs.",
    });
    const seen: string[] = [];
    await runReplyJob(
      second,
      () => {},
      github,
      capturingAi("Thanks, that helps.", seen),
    );
    if (!seen[0]?.includes("is already closed")) {
      throw new Error("the closed note was not asked");
    }
    const feedback = listAudit({}, 50, 0).items.find(
      (row) => row.summary === "Feedback on a closed finding",
    );
    if (
      !JSON.stringify(feedback?.changes ?? []).includes("checked by the caller")
    ) {
      throw new Error(`audit: ${JSON.stringify(feedback)}`);
    }
  });
});

test("the CLOSED line counts only as the last line, alone", () => {
  if (!takeCloseLine("Closed.\nCLOSED").closed) throw new Error("not taken");
  if (takeCloseLine("CLOSED is the word.\nIt stays.").closed) {
    throw new Error("taken from the middle");
  }
});

test("the WITHDRAWN line counts only as the last line, alone", () => {
  const cases: Array<[string, boolean, string]> = [
    ["Agreed.\nWITHDRAWN", true, "Agreed."],
    ["Agreed.\n  WITHDRAWN  \n\n", true, "Agreed."],
    ["WITHDRAWN is the word.\nThe finding stands.", false, ""],
    ["The finding stands. WITHDRAWN", false, ""],
  ];
  for (const [answer, withdrawn, text] of cases) {
    const result = takeWithdrawLine(answer);
    if (result.withdrawn !== withdrawn) {
      throw new Error(
        `${JSON.stringify(answer)}: withdrawn ${result.withdrawn}`,
      );
    }
    if (withdrawn && result.text !== text) {
      throw new Error(
        `${JSON.stringify(answer)}: text ${JSON.stringify(result.text)}`,
      );
    }
  }
});

test("Stop before a reply asks the AI makes no call and posts nothing", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const job = requestJob("review_comment", "110", "10");
    const stop = new AbortController();
    stop.abort();
    let calls = 0;
    const ai: AiProvider = {
      complete: () => {
        calls++;
        return Promise.resolve({
          text: "answer",
          tokensIn: 1,
          tokensOut: 1,
          model: "fake",
          provider: "openrouter",
        });
      },
    };
    await runReplyJob(job, () => {}, github, ai, stop.signal);
    if (calls !== 0) throw new Error(`${calls} AI calls after Stop`);
    if (github.writes.length !== 0) throw new Error("posted after Stop");
  });
});

test("a reply on a finding gets the rules the finding rests on, with their text and links", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const job = requestJob("review_comment", "109", "10");
    const findingId = postedFinding(job.id);
    getAppDb()
      .prepare(`UPDATE findings SET references_json = ? WHERE id = ?`)
      .run(
        JSON.stringify([
          {
            kind: "rule",
            id: "R12",
            sources: [
              {
                pr: 212,
                url: "https://github.com/acme/widgets/pull/212#discussion_r1",
                mergedAt: "2026-03-04",
              },
            ],
          },
        ]),
        findingId,
      );
    await writeTextFile(
      `${getEnv("CM_REPOS_DIR")}/acme/widgets/RULES.json`,
      JSON.stringify({
        schemaVersion: 1,
        builtAt: "2026-11-01T00:00:00.000Z",
        rules: {
          R12: {
            file: "PR_REVIEW_GUIDE.md",
            text: "Percentages round half up",
            sources: [{ pr: 212 }],
          },
        },
      }),
    );
    let prompt = "";
    const ai: AiProvider = {
      complete: (request) => {
        prompt = request.prompt;
        return Promise.resolve({
          text: "It follows Rules-12.",
          tokensIn: 1,
          tokensOut: 1,
          model: "fake",
          provider: "openrouter",
        });
      },
    };
    await runReplyJob(job, () => {}, github, ai);
    for (const needle of [
      "Percentages round half up",
      "Rules-12",
      "pull/212#discussion_r1",
    ]) {
      if (!prompt.includes(needle)) {
        throw new Error(`the reply context lacks ${needle}`);
      }
    }
  });
});

test("the rules a reply gets from a finding are capped", () => {
  const references = Array.from({ length: 12 }, (_, index) => ({
    kind: "rule",
    id: `R${index + 1}`,
    sources: [],
  }));
  const rules = {
    schemaVersion: 1,
    builtAt: "2026-11-01T00:00:00.000Z",
    rules: {
      R1: { file: "PR_REVIEW_GUIDE.md", text: "x".repeat(5000), sources: [] },
    },
  };
  const out = findingRules(JSON.stringify(references), rules as never);
  if (out.length !== 10) throw new Error(`${out.length} rules`);
  if ((out[0]?.text?.length ?? 0) > 700) {
    throw new Error(`a rule text of ${out[0]?.text?.length} chars`);
  }
});

const DASH = String.fromCharCode(0x2014);
const SEMI = String.fromCharCode(59);

test("a reply's prose is posted without an em dash or a semicolon, code keeps its own", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const job = requestJob("review_comment", "111", "10");
    await runReplyJob(
      job,
      () => {},
      github,
      replyAi(
        `It follows R3 ${DASH} Parse Error Consistency${SEMI} see below.\n\n\`\`\`js\nthrow new RangeError("x")${SEMI}\n\`\`\``,
      ),
    );
    const body = (github.writes[0]!.body as { body: string }).body;
    if (!body.includes("It follows R3, Parse Error Consistency. see below.")) {
      throw new Error(body);
    }
    if (!body.includes(`throw new RangeError("x")${SEMI}`)) {
      throw new Error(`code was changed: ${body}`);
    }
  });
});
