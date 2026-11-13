/** A `serve` App review with extensions: the posted review carries their
 * findings inline and in the summary, the `#### Extensions` section, the
 * Metadata lines and their verdict, and the next round tracks keyed findings
 * from app.db. */
import { test } from "node:test";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo, markKnowledgeBuilt } from "../store/repos.ts";
import { insertJob, setJobStatus } from "../store/jobs.ts";
import { getReviewByJobId } from "../store/reviews.ts";
import { FakeAiProvider } from "../ai/fake.ts";
import { runReviewJob } from "../services/review.ts";
import { loadExtensionReport } from "./../store/extensions.ts";
import type { GitHubClient, Json } from "../types.ts";
import type { JobRow } from "../store/rows.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";

const posixOnly = { skip: process.platform === "win32" };

const EXTENSION = `import { readFileSync } from "node:fs";
const details = JSON.parse(readFileSync(process.argv[2], "utf8"));
const first = details.round === 1;
console.log(JSON.stringify({
  schemaVersion: 1, name: "secret", status: "ok",
  verdict: first ? "request_changes" : "comment",
  markdown: "Scanned **12** files.",
  findings: first
    ? [
        { key: "aws", severity: "P1", blocking: true, title: "AWS key in code", body: "Rotate it.", path: "src/app.ts", lineFrom: 4 },
        { key: "env", severity: "P2", blocking: false, title: "Token in README", body: "Remove it.", path: "README.md", lineFrom: 1 },
      ]
    : [{ key: "env", severity: "P2", blocking: false, title: "Token in README", body: "Remove it.", path: "README.md", lineFrom: 1 }],
  usage: { costUsd: 0.5 },
}));
`;

class FakeGithub implements GitHubClient {
  writes: { endpoint: string; body: Json }[] = [];
  request<T>(endpoint: string): Promise<T> {
    if (endpoint.includes("/compare/")) {
      return Promise.resolve({ files: this.files() } as T);
    }
    if (endpoint.includes("/pulls/1")) {
      return Promise.resolve({
        title: "Change",
        body: "",
        state: "open",
        head: { sha: "head1", ref: "feature" },
        base: { sha: "base1", ref: "main" },
      } as T);
    }
    throw new Error(`unexpected request ${endpoint}`);
  }
  files(): Json[] {
    return [{ filename: "src/app.ts", patch: "@@ -4 +4 @@\n-a\n+b" }];
  }
  pages<T>(endpoint: string): Promise<T[]> {
    if (endpoint.includes("/files"))
      return Promise.resolve(this.files() as T[]);
    return Promise.resolve([]);
  }
  /** Every post fails, the review and its issue comment fallback alike. */
  failPosts = false;
  write<T>(endpoint: string, body: unknown): Promise<T> {
    if (this.failPosts && /\/(reviews|comments)$/.test(endpoint)) {
      return Promise.reject(new Error("GitHub is down"));
    }
    this.writes.push({ endpoint, body: body as Json });
    return Promise.resolve({ id: 1000 + this.writes.length } as T);
  }
}

function job(id: string, trigger: string): JobRow {
  insertJob({
    id,
    type: "review",
    repo: "acme/widgets",
    prNumber: 1,
    args: { trigger },
  });
  return {
    id,
    type: "review",
    repo: "acme/widgets",
    pr_number: 1,
    status: "running",
    args: JSON.stringify({ trigger }),
    delivery_id: null,
    queue_key: null,
    attempt: 0,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    error: null,
    superseded_by: null,
    cancel_reason: null,
  };
}

async function withServe(
  fn: () => Promise<void>,
  extensions?: object[],
): Promise<void> {
  const saved = [
    "CM_APP_DB",
    "CM_REPOS_DIR",
    "CM_CONFIG_PATH",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
  ].map((name) => [name, getEnv(name)] as const);
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("XDG_CACHE_HOME", `${dir}/cache`);
  setEnv("XDG_CONFIG_HOME", `${dir}/config-home`);
  await mkdirPath(`${dir}/repos/acme/widgets`, { recursive: true });
  await writeTextFile(
    `${dir}/repos/acme/widgets/PR_REVIEW_GUIDE.md`,
    "# guide\n",
  );
  await writeTextFile(`${dir}/ext.mjs`, EXTENSION);
  await writeTextFile(
    `${dir}/config.json`,
    JSON.stringify({
      extensions: extensions ?? [
        {
          name: "secret",
          command: `${process.execPath} ${dir}/ext.mjs {{details_path}}`,
          repos: "*",
          parallelism: true,
          priority: 0,
          failFast: false,
          retryOnFailTimes: 0,
          maxRequestedRetries: 3,
          timeoutSeconds: 60,
        },
        {
          name: "broken",
          command: "exit 2",
          repos: "*",
          parallelism: true,
          priority: 0,
          failFast: false,
          retryOnFailTimes: 0,
          maxRequestedRetries: 3,
          timeoutSeconds: 60,
        },
      ],
    }),
  );
  try {
    await openAppDb();
    activateRepo("acme/widgets", 7);
    markKnowledgeBuilt("acme/widgets", "head1");
    await fn();
  } finally {
    await closeAppDb();
    for (const [name, value] of saved) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
  }
}

type Posted = {
  event: string;
  body: string;
  comments: { path: string; line: number; body: string }[];
};

test(
  "an App review posts its extensions and tracks them into the next round",
  posixOnly,
  async () => {
    await withServe(async () => {
      const github = new FakeGithub();
      await runReviewJob(
        job("job-1", "opened"),
        () => {},
        github,
        new FakeAiProvider(),
      );
      const posted = github.writes.find((write) =>
        write.endpoint.endsWith("/reviews"),
      )!.body as unknown as Posted;
      if (posted.event !== "REQUEST_CHANGES") throw new Error(posted.event);
      const inline = posted.comments.find((c) =>
        c.body.includes("extension: secret"),
      );
      if (!inline || inline.path !== "src/app.ts" || inline.line !== 4) {
        throw new Error(JSON.stringify(posted.comments));
      }
      if (!inline.body.startsWith("[P1 · blocking] · extension: secret")) {
        throw new Error(inline.body);
      }
      for (const needle of [
        "Extension findings (1)",
        "- [P2 · non-blocking] · extension: secret: Token in README (README.md:1)",
        "broken extension failed, you can see details in dashboard",
        "#### Extensions",
        "<details><summary>secret</summary>\n\nScanned **12** files.\n\n</details>",
        "- Extensions: [secret]",
        "- Failed Extensions: [broken]",
        "- Requested changes: [secret]",
      ]) {
        if (!posted.body.includes(needle)) {
          throw new Error(
            `missing ${JSON.stringify(needle)} in:\n${posted.body}`,
          );
        }
      }
      if (
        posted.body.indexOf("#### Extensions") >
        posted.body.indexOf("<summary>Metadata</summary>")
      ) {
        throw new Error("the Extensions section is not before Metadata");
      }
      const review = getReviewByJobId("job-1")!;
      const stored = loadExtensionReport(review.id);
      const broken = stored.results.find((row) => row.name === "broken");
      if (
        broken?.status !== "failed" ||
        !broken.details?.includes("exit code: 2")
      ) {
        throw new Error(JSON.stringify(broken));
      }
      if (review.cost === null || review.cost < 0.5) {
        throw new Error(
          `the extension cost is not in the total: ${review.cost}`,
        );
      }

      setJobStatus("job-1", "done");
      const second = new FakeGithub();
      await runReviewJob(
        job("job-2", "synchronize"),
        () => {},
        second,
        new FakeAiProvider(),
      );
      const next = loadExtensionReport(getReviewByJobId("job-2")!.id);
      const states = new Map(next.findings.map((row) => [row.key, row.state]));
      if (states.get("aws") !== "closed" || states.get("env") !== "open") {
        throw new Error(JSON.stringify([...states]));
      }
      const repost = second.writes.find((write) =>
        write.endpoint.endsWith("/reviews"),
      )!.body as unknown as Posted;
      if (!repost.body.includes("Token in README (README.md:1) (still open)")) {
        throw new Error(repost.body);
      }
    });
  },
);

test(
  "findings of a review that failed to post are new again next round",
  posixOnly,
  async () => {
    await withServe(async () => {
      const failing = new FakeGithub();
      failing.failPosts = true;
      await runReviewJob(
        job("job-fail", "opened"),
        () => {},
        failing,
        new FakeAiProvider(),
      ).catch(() => {});
      setJobStatus("job-fail", "failed");
      const second = new FakeGithub();
      await runReviewJob(
        job("job-next", "synchronize"),
        () => {},
        second,
        new FakeAiProvider(),
      );
      const next = loadExtensionReport(getReviewByJobId("job-next")!.id);
      const aws = next.findings.find((row) => row.key === "aws");
      if (aws?.state !== "new") throw new Error(JSON.stringify(next.findings));
      const posted = second.writes.find((write) =>
        write.endpoint.endsWith("/reviews"),
      )!.body as unknown as Posted;
      if (!posted.comments.some((c) => c.body.includes("AWS key in code"))) {
        throw new Error("the inline comment was lost");
      }
    });
  },
);

test("a Stop while extensions run posts nothing", posixOnly, async () => {
  await withServe(async () => {
    const github = new FakeGithub();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = performance.now();
    await runReviewJob(
      job("job-stop", "opened"),
      () => {},
      github,
      new FakeAiProvider(),
      controller.signal,
    );
    if (performance.now() - started > 8_000) throw new Error("waited");
    if (github.writes.some((write) => write.endpoint.endsWith("/reviews"))) {
      throw new Error("a review was posted with cut-off extensions");
    }
  }, [
    {
      name: "slow",
      command: "sleep 20",
      repos: "*",
      parallelism: true,
      priority: 0,
      failFast: false,
      retryOnFailTimes: 0,
      maxRequestedRetries: 3,
      timeoutSeconds: 60,
    },
  ]);
});
