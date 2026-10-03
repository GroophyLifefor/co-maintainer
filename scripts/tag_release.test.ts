import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDirSync } from "../src/testing/runtime.ts";
import {
  applyPlan,
  githubRefs,
  parseVersion,
  planTags,
  type Refs,
  type Tag,
  type TagStep,
} from "./tag_release.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

function plan(version: string, sha: string, existing: Tag[] = []): string[] {
  return planTags({ version, sha, existing }).map((step) =>
    step.kind === "skip"
      ? `skip ${step.name}`
      : `${step.kind} ${step.name}@${step.sha[0]}`,
  );
}

function expectPlan(got: string[], want: string[]): void {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(
      `got ${JSON.stringify(got)}\nwanted ${JSON.stringify(want)}`,
    );
  }
}

test("a stable release creates its own tag and the tag for its major", () => {
  expectPlan(plan("0.5.1", A), ["create v0.5.1@a", "create v0@a"]);
});

test("a prerelease only gets its own tag, the major tag is never touched", () => {
  expectPlan(plan("0.5.1-beta.1", A), ["create v0.5.1-beta.1@a"]);
  expectPlan(
    plan("0.5.1-beta.1", B, [
      { name: "v0", sha: A },
      { name: "v0.5.0", sha: A },
    ]),
    ["create v0.5.1-beta.1@b"],
  );
});

test("the major tag moves to the new stable release", () => {
  expectPlan(
    plan("0.5.1", B, [
      { name: "v0", sha: A },
      { name: "v0.5.0", sha: A },
    ]),
    ["create v0.5.1@b", "move v0@b"],
  );
});

test("a run that finds everything done changes nothing", () => {
  expectPlan(
    plan("0.5.1", B, [
      { name: "v0.5.1", sha: B },
      { name: "v0", sha: B },
    ]),
    ["skip v0.5.1", "skip v0"],
  );
});

test("an existing version tag at another commit is left alone, and the major tag follows it", () => {
  const steps = planTags({
    version: "0.5.1",
    sha: B,
    existing: [{ name: "v0.5.1", sha: A }],
  });
  const first = steps[0] as Extract<TagStep, { kind: "skip" }>;
  if (first.kind !== "skip" || !first.reason.includes("left alone")) {
    throw new Error(JSON.stringify(steps));
  }
  expectPlan(
    steps.map((s) =>
      s.kind === "skip" ? `skip ${s.name}` : `${s.kind} ${s.name}@${s.sha[0]}`,
    ),
    ["skip v0.5.1", "create v0@a"],
  );
});

test("re-running an old release never moves the major tag backwards", () => {
  expectPlan(
    plan("0.5.1", A, [
      { name: "v0.6.0", sha: C },
      { name: "v0", sha: C },
    ]),
    ["create v0.5.1@a", "skip v0"],
  );
  expectPlan(
    plan("0.5.1", A, [
      { name: "v0.6.0", sha: C },
      { name: "v0", sha: B },
    ]),
    ["create v0.5.1@a", "move v0@c"],
  );
});

test("versions are compared as numbers, not as text", () => {
  expectPlan(
    plan("0.9.0", A, [
      { name: "v0.10.0", sha: C },
      { name: "v0", sha: C },
    ]),
    ["create v0.9.0@a", "skip v0"],
  );
});

test("a prerelease tag never counts as the newest stable release", () => {
  expectPlan(
    plan("0.5.1", A, [
      { name: "v0.6.0-beta.1", sha: C },
      { name: "v0", sha: B },
    ]),
    ["create v0.5.1@a", "move v0@a"],
  );
});

test("a later major gets its own tag and leaves v0 alone", () => {
  expectPlan(
    plan("1.0.0", B, [
      { name: "v0.9.0", sha: A },
      { name: "v0", sha: A },
    ]),
    ["create v1.0.0@b", "create v1@b"],
  );
  expectPlan(
    plan("1.1.0", C, [
      { name: "v1.0.0", sha: B },
      { name: "v1", sha: B },
      { name: "v0", sha: A },
    ]),
    ["create v1.1.0@c", "move v1@c"],
  );
});

test("a version that is not a release version is refused", () => {
  for (const bad of [
    "0.5",
    "v0.5.1",
    "0.5.1+build",
    "01.2.3",
    "0.5.1-",
    "",
    "latest",
  ]) {
    let message = "";
    try {
      parseVersion(bad);
    } catch (error) {
      message = (error as Error).message;
    }
    if (!message.includes("is not a release version")) {
      throw new Error(`${JSON.stringify(bad)} was accepted`);
    }
  }
  const ok = parseVersion("10.20.30-rc.1");
  if (ok.major !== 10 || ok.minor !== 20 || ok.patch !== 30 || !ok.prerelease) {
    throw new Error(JSON.stringify(ok));
  }
});

function memoryRefs(): { refs: Refs; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    refs: {
      list: () => Promise.resolve([]),
      create: (name, sha) => {
        calls.push(`create ${name} ${sha[0]}`);
        return Promise.resolve();
      },
      move: (name, sha) => {
        calls.push(`move ${name} ${sha[0]}`);
        return Promise.resolve();
      },
    },
  };
}

test("applyPlan writes each step in order, and a dry run writes nothing", async () => {
  const steps = planTags({
    version: "0.5.1",
    sha: B,
    existing: [{ name: "v0", sha: A }],
  });
  const real = memoryRefs();
  const lines = await applyPlan(real.refs, steps);
  if (
    JSON.stringify(real.calls) !==
    JSON.stringify(["create v0.5.1 b", "move v0 b"])
  ) {
    throw new Error(JSON.stringify(real.calls));
  }
  if (lines[0] !== `v0.5.1: create at ${B.slice(0, 7)}`)
    throw new Error(lines[0]);
  const dry = memoryRefs();
  const dryLines = await applyPlan(dry.refs, steps, { dryRun: true });
  if (dry.calls.length !== 0) throw new Error("a dry run wrote");
  if (!dryLines[1]!.includes("would move")) throw new Error(dryLines[1]);
});

type Seen = {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
};

/** A GitHub API that answers for one repository and records what it was asked. */
async function fakeGithub(tags: Tag[]) {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        auth: request.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      });
      const url = new URL(request.url ?? "", "http://x");
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (url.pathname === "/repos/o/r/git/matching-refs/tags/v") {
        const page = Number(url.searchParams.get("page"));
        send(
          200,
          tags.slice((page - 1) * 100, page * 100).map((t) => ({
            ref: `refs/tags/${t.name}`,
            object: { sha: t.sha, type: "commit" },
          })),
        );
      } else if (
        request.method === "POST" &&
        url.pathname === "/repos/o/r/git/refs"
      ) {
        const body = JSON.parse(raw) as { ref: string };
        if (body.ref === "refs/tags/v9.9.9") {
          send(422, { message: "Reference already exists" });
        } else send(201, {});
      } else if (
        request.method === "PATCH" &&
        url.pathname.startsWith("/repos/o/r/git/refs/tags/")
      ) {
        send(200, {});
      } else send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    seen,
    apiUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("the GitHub layer pages through every tag and sends the calls GitHub documents", async () => {
  const many: Tag[] = Array.from({ length: 102 }, (_, i) => ({
    name: `v0.0.${i}`,
    sha: A,
  }));
  const github = await fakeGithub(many);
  try {
    const refs = githubRefs({
      repo: "o/r",
      token: "tok",
      apiUrl: github.apiUrl,
    });
    const listed = await refs.list();
    if (listed.length !== 102 || listed[101]!.name !== "v0.0.101") {
      throw new Error(`${listed.length} tags`);
    }
    if (github.seen.filter((s) => s.method === "GET").length !== 2) {
      throw new Error("the second page was not read");
    }
    await refs.create("v0.5.1", B);
    await refs.move("v0", B);
    const post = github.seen.find((s) => s.method === "POST")!;
    const patch = github.seen.find((s) => s.method === "PATCH")!;
    if (
      JSON.stringify(post.body) !==
      JSON.stringify({ ref: "refs/tags/v0.5.1", sha: B })
    ) {
      throw new Error(JSON.stringify(post.body));
    }
    if (
      patch.url !== "/repos/o/r/git/refs/tags/v0" ||
      JSON.stringify(patch.body) !== JSON.stringify({ sha: B, force: true })
    ) {
      throw new Error(`${patch.url} ${JSON.stringify(patch.body)}`);
    }
    for (const call of github.seen) {
      if (call.auth !== "Bearer tok")
        throw new Error(`${call.method}: ${call.auth}`);
    }
  } finally {
    await github.close();
  }
});

test("a refused call fails with what GitHub said", async () => {
  const github = await fakeGithub([]);
  try {
    const refs = githubRefs({
      repo: "o/r",
      token: "tok",
      apiUrl: github.apiUrl,
    });
    let message = "";
    try {
      await refs.create("v9.9.9", A);
    } catch (error) {
      message = (error as Error).message;
    }
    if (
      !message.includes("422") ||
      !message.includes("Reference already exists")
    ) {
      throw new Error(message);
    }
  } finally {
    await github.close();
  }
});

function runScript(
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(here, "tag_release.ts"), ...args],
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          SYSTEMROOT: process.env.SYSTEMROOT ?? "",
          ...env,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the real script tags a stable release end to end and is safe to run again", async () => {
  const dir = tempDirSync();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ version: "0.5.1" }),
  );
  const github = await fakeGithub([{ name: "v0", sha: A }]);
  try {
    const env = {
      GITHUB_REPOSITORY: "o/r",
      GITHUB_SHA: B,
      GITHUB_TOKEN: "tok",
      GITHUB_API_URL: github.apiUrl,
    };
    const first = await runScript([], env, dir);
    if (first.code !== 0)
      throw new Error(`exit ${first.code}\n${first.stderr}`);
    const lines = first.stdout.trim().split("\n");
    if (
      lines[0] !== `v0.5.1: create at ${B.slice(0, 7)}` ||
      lines[1] !== `v0: move at ${B.slice(0, 7)}`
    ) {
      throw new Error(first.stdout);
    }
    const writes = github.seen.filter((s) => s.method !== "GET");
    if (writes.length !== 2) throw new Error(`${writes.length} writes`);

    const dry = await runScript(["--dry-run"], env, dir);
    if (dry.code !== 0 || !dry.stdout.includes("would create")) {
      throw new Error(`dry run: ${dry.code}\n${dry.stdout}${dry.stderr}`);
    }
    if (github.seen.filter((s) => s.method !== "GET").length !== 2) {
      throw new Error("a dry run wrote to GitHub");
    }
  } finally {
    await github.close();
  }
});

test("the real script fails clearly without its settings or with a bad version", async () => {
  const dir = tempDirSync();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ version: "0.5.1" }),
  );
  const missing = await runScript([], {}, dir);
  if (missing.code !== 1 || !missing.stderr.includes("GITHUB_SHA is not set")) {
    throw new Error(`${missing.code} ${missing.stderr}`);
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ version: "latest" }),
  );
  const github = await fakeGithub([]);
  try {
    const bad = await runScript(
      [],
      {
        GITHUB_REPOSITORY: "o/r",
        GITHUB_SHA: A,
        GITHUB_TOKEN: "tok",
        GITHUB_API_URL: github.apiUrl,
      },
      dir,
    );
    if (bad.code !== 1 || !bad.stderr.includes("is not a release version")) {
      throw new Error(`${bad.code} ${bad.stderr}`);
    }
    if (github.seen.some((s) => s.method !== "GET")) {
      throw new Error("nothing may be written for a bad version");
    }
  } finally {
    await github.close();
  }
});

const publish = readFileSync(
  join(root, ".github/workflows/publish.yml"),
  "utf8",
);
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const beta = readFileSync(
  join(root, ".github/workflows/publish-beta.yml"),
  "utf8",
);

/** The text of one top-level job, up to the next job or the end. */
function job(text: string, name: string): string {
  const start = text.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  if (start === -1) throw new Error(`no ${name} job`);
  const rest = text.slice(start + 1);
  const next = rest.search(/^ {2}[a-z][\w-]*:\s*$/m);
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next);
}

test("the tag job waits for the package and the image, and is the only one that can write", () => {
  const tag = job(publish, "tag");
  if (!/needs: \[publish, docker\]/.test(tag))
    throw new Error("tag must need both");
  if (!/contents: write/.test(tag))
    throw new Error("tag needs contents: write");
  if (!tag.includes("run: node scripts/tag_release.ts"))
    throw new Error("tag runs the script");
  if (!tag.includes("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}")) {
    throw new Error("tag must use the workflow token");
  }
  if (/secrets\.(?!GITHUB_TOKEN)\w+/.test(tag)) {
    throw new Error("a personal token would start other workflows");
  }
  for (const other of ["publish", "docker"]) {
    if (/contents: write/.test(job(publish, other))) {
      throw new Error(`${other} must not gain write access`);
    }
  }
  if (!/contents: read/.test(job(publish, "publish")))
    throw new Error("publish permissions changed");
  if (!/packages: write/.test(job(publish, "docker")))
    throw new Error("docker permissions changed");
});

test("neither CI nor publish starts on a tag, so the tags the job makes cannot loop", () => {
  for (const [name, text] of [
    ["publish.yml", publish],
    ["ci.yml", ci],
  ] as const) {
    const on = text.slice(text.indexOf("\non:"), text.indexOf("\njobs:"));
    if (/^\s+tags:/m.test(on)) throw new Error(`${name} starts on a tag`);
  }
  // publish-beta does start on a prerelease tag, but a tag made with
  // GITHUB_TOKEN starts no workflow, which is the reason the job uses it.
  if (!/tags:\s*\n\s*- "v\*-\*"/.test(beta))
    throw new Error("publish-beta trigger changed");
});

test("CI lints the workflows with a pinned actionlint", () => {
  const lint = job(ci, "actionlint");
  if (!/actionlint@v\d+\.\d+\.\d+/.test(lint))
    throw new Error("actionlint must be pinned");
  if (/@latest/.test(lint)) throw new Error("no floating version");
});
