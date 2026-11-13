/** The simulated GitHub on its own: pull requests as real branches, what git
 * computes for them, and the writes it records. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { RouteRequest } from "./github.ts";
import { SAMPLE_REPO, SAMPLE_REPO_NAME } from "./sample_repo.ts";
import { createWorld } from "./world.ts";

const world = createWorld();
after(() => world.dispose());
const repo = world.createRepo(SAMPLE_REPO_NAME, SAMPLE_REPO);
const github = world.github;

type Json = Record<string, any>;

function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): { status: number; body: Json } {
  const request: RouteRequest = {
    method,
    url: new URL(`https://api.github.com/${path}`),
    body: body ?? null,
    via: "fetch",
    step: "test",
    ...(token ? { token } : {}),
  };
  const result = github.route(request);
  assert.ok(result, `no route for ${method} ${path}`);
  return result as { status: number; body: Json };
}

const BASE = `repos/${SAMPLE_REPO_NAME}`;

test("a pull request is a real branch, and its files come from git", () => {
  const pull = github.openPull(SAMPLE_REPO_NAME, {
    title: "Clamp below zero",
    body: "Fixes the clamp.",
    author: "alice",
    files: {
      "src/math.ts": SAMPLE_REPO["src/math.ts"]!.replace("a + b", "b + a"),
      "src/new.ts": "export const x = 1;\n",
      "src/format.ts": null,
    },
  });
  const head = world.git(repo, ["rev-parse", pull.headRef]).toString().trim();
  assert.equal(head, pull.headSha);
  assert.equal(
    world.git(repo, ["rev-parse", "refs/pull/1/head"]).toString().trim(),
    pull.headSha,
  );

  const json = call("GET", `${BASE}/pulls/1`).body;
  assert.equal(json.title, "Clamp below zero");
  assert.equal(json.user.login, "alice");
  assert.equal(json.head.sha, pull.headSha);
  assert.equal(json.head.repo.full_name, SAMPLE_REPO_NAME);
  assert.equal(json.changed_files, 3);

  const files = call("GET", `${BASE}/pulls/1/files`).body as Json[];
  const byName = Object.fromEntries(files.map((file) => [file.filename, file]));
  assert.equal(byName["src/math.ts"].status, "modified");
  assert.match(
    byName["src/math.ts"].patch,
    /^@@ .*\n[\s\S]*\+  return b \+ a;/,
  );
  assert.equal(byName["src/new.ts"].status, "added");
  assert.equal(byName["src/format.ts"].status, "removed");
});

test("push, force-push, merge and close move the pull request like GitHub", () => {
  const pull = github.openPull(SAMPLE_REPO_NAME, {
    title: "Two steps",
    files: { "a.txt": "one\n" },
  });
  const first = pull.headSha;
  const second = github.push(pull, { "b.txt": "two\n" });
  assert.equal(pull.headSha, second);
  assert.equal(call("GET", `${BASE}/pulls/${pull.number}`).body.commits, 2);

  const rewritten = github.forcePush(pull, { "c.txt": "three\n" });
  // `--is-ancestor` exits 1 when it is not, which `git` reports as a throw.
  assert.throws(
    () => world.git(repo, ["merge-base", "--is-ancestor", first, rewritten]),
    "the old head is still an ancestor",
  );
  const files = (
    call("GET", `${BASE}/pulls/${pull.number}/files`).body as Json[]
  ).map((file) => file.filename);
  assert.deepEqual(files, ["c.txt"]);

  const merge = github.merge(pull);
  const json = call("GET", `${BASE}/pulls/${pull.number}`).body;
  assert.equal(json.state, "closed");
  assert.equal(json.merged, true);
  assert.equal(json.merge_commit_sha, merge);
  const main = world.git(repo, ["rev-parse", "main"]).toString().trim();
  assert.equal(main, merge);

  const other = github.openPull(SAMPLE_REPO_NAME, {
    title: "Closed",
    files: { "d.txt": "d\n" },
  });
  github.close(other);
  const open = (call("GET", `${BASE}/pulls?state=open`).body as Json[]).map(
    (row) => row.number,
  );
  assert.ok(!open.includes(other.number) && !open.includes(pull.number));
});

test("a fork's head lives only under refs/pull", () => {
  const pull = github.openPull(SAMPLE_REPO_NAME, {
    title: "From a fork",
    author: "mallory",
    fork: true,
    files: { "f.txt": "fork\n" },
  });
  const json = call("GET", `${BASE}/pulls/${pull.number}`).body;
  assert.equal(json.head.repo.full_name, "mallory/sample");
  assert.equal(json.head.repo.fork, true);
  const branches = world
    .git(repo, ["branch", "--list", pull.headRef])
    .toString();
  assert.equal(branches, "");
});

test("comments, reviews and check runs are listed and created, every write in order", () => {
  const pull = github.openPull(SAMPLE_REPO_NAME, {
    title: "Talk",
    files: { "src/math.ts": "export const add = 1;\n" },
  });
  const n = pull.number;
  const before = github.writes.length;
  const bot = "ghs_test";

  const comment = call(
    "POST",
    `${BASE}/issues/${n}/comments`,
    { body: "hello" },
    bot,
  );
  assert.equal(comment.status, 201);
  assert.equal(comment.body.user.type, "Bot");
  const edited = call("PATCH", `${BASE}/issues/comments/${comment.body.id}`, {
    body: "hello again",
  });
  assert.equal(edited.body.body, "hello again");

  const review = call(
    "POST",
    `${BASE}/pulls/${n}/reviews`,
    {
      event: "COMMENT",
      body: "summary",
      comments: [
        { path: "src/math.ts", line: 1, side: "RIGHT", body: "inline" },
      ],
    },
    bot,
  );
  assert.equal(review.body.state, "COMMENTED");
  const inline = call("GET", `${BASE}/pulls/${n}/comments`).body as Json[];
  assert.equal(inline.length, 1);
  assert.equal(inline[0]!.pull_request_review_id, review.body.id);
  assert.equal(inline[0]!.commit_id, pull.headSha);

  const reply = call(
    "POST",
    `${BASE}/pulls/${n}/comments/${inline[0]!.id}/replies`,
    {
      body: "a reply",
    },
  );
  assert.equal(reply.body.in_reply_to_id, inline[0]!.id);
  assert.equal(reply.body.path, "src/math.ts");

  const run = call("POST", `${BASE}/check-runs`, {
    name: "co-maintainer",
    head_sha: pull.headSha,
    status: "in_progress",
  });
  call("PATCH", `${BASE}/check-runs/${run.body.id}`, {
    conclusion: "success",
    output: { title: "done", summary: "ok" },
  });
  const runs = call("GET", `${BASE}/commits/${pull.headSha}/check-runs`).body;
  assert.equal(runs.check_runs[0].status, "completed");
  assert.equal(runs.check_runs[0].conclusion, "success");

  const writes = github.writes
    .slice(before)
    .map(
      (write) =>
        `${write.seq - before} ${write.method} ${write.path.replace(BASE, "")}`,
    );
  assert.deepEqual(writes, [
    `1 POST /issues/${n}/comments`,
    `2 PATCH /issues/comments/${comment.body.id}`,
    `3 POST /pulls/${n}/reviews`,
    `4 POST /pulls/${n}/comments/${inline[0]!.id}/replies`,
    "5 POST /check-runs",
    `6 PATCH /check-runs/${run.body.id}`,
  ]);
  assert.equal(github.writesTo(/check-runs/).length, 2);
});

test("commits and compare are what git says", () => {
  const { before, after } = github.commitToDefault(SAMPLE_REPO_NAME, {
    "src/extra.ts": "export const extra = true;\n",
  });
  const compare = call("GET", `${BASE}/compare/${before}...${after}`).body;
  assert.equal(compare.status, "ahead");
  assert.equal(compare.total_commits, 1);
  assert.deepEqual(
    (compare.files as Json[]).map((file) => file.filename),
    ["src/extra.ts"],
  );
  const commits = call("GET", `${BASE}/commits?sha=main&per_page=1`)
    .body as Json[];
  assert.equal(commits.length, 1);
  assert.equal(commits[0]!.sha, after);
  const tree = call("GET", `${BASE}/git/trees/main?recursive=1`).body;
  assert.ok(
    (tree.tree as Json[]).some((entry) => entry.path === "src/extra.ts"),
  );
  const content = call("GET", `${BASE}/contents/src/extra.ts?ref=main`).body;
  assert.equal(
    Buffer.from(content.content, "base64").toString(),
    "export const extra = true;\n",
  );
});

test("a missing resource is a 404 GitHub answers, an unknown route is no answer", () => {
  assert.equal(call("GET", `${BASE}/pulls/999`).status, 404);
  assert.equal(call("GET", `${BASE}/contents/nope.ts`).status, 404);
  const unknown = github.route({
    method: "GET",
    url: new URL(`https://api.github.com/${BASE}/deployments`),
    body: null,
    via: "fetch",
    step: "test",
  });
  assert.equal(unknown, undefined);
  const otherRepo = github.route({
    method: "GET",
    url: new URL("https://api.github.com/repos/nobody/nothing"),
    body: null,
    via: "fetch",
    step: "test",
  });
  assert.equal(otherRepo, undefined);
});

test("the App installation and its token", () => {
  const installations = call("GET", "app/installations")
    .body as unknown as Json[];
  const id = installations[0]!.id;
  const token = call("POST", `app/installations/${id}/access_tokens`);
  assert.equal(token.status, 201);
  assert.match(token.body.token, /^ghs_/);
  const repos = call("GET", "installation/repositories").body;
  assert.deepEqual(
    (repos.repositories as Json[]).map((row) => row.full_name),
    [SAMPLE_REPO_NAME],
  );
  assert.ok(
    !github.writes.some((write) => write.path.includes("access_tokens")),
    "minting a token is not a write anyone sees",
  );
});
