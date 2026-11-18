/** `review --with`: the flag and its errors, a companion read from its
 * working tree and one read at a branch without a checkout, and the
 * visibility rule. The checkouts are real git repositories in a temp folder,
 * with a GitHub remote that is never contacted. */
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./error.ts";
import { parseReviewArgs, filterReviewConfigArgs } from "./review_args.ts";
import {
  loadCompanions,
  readCompanionVisibility,
  splitWithValue,
  withFlagValues,
} from "./review_with.ts";
import { tempDirSync } from "../testing/runtime.ts";
import type { Companion } from "../review/companions.ts";
import { isolateTestFile } from "../testing/locations.ts";

isolateTestFile();

function must(value: boolean, what: string): void {
  if (!value) throw new Error(what);
}

function git(dir: string, args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A checkout of `repo` whose `origin/main` is its first commit. */
function checkout(root: string, name: string, repo: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "README.md"), "# readme\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "first"]);
  git(dir, ["remote", "add", "origin", `git@github.com:${repo}.git`]);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return dir;
}

async function usageError(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 2) return error.message;
    throw error;
  }
  throw new Error("no usage error");
}

function world(): {
  root: string;
  app: string;
  docs: string;
  done: () => void;
} {
  const root = tempDirSync();
  const done = () => rmSync(root, { recursive: true, force: true });
  try {
    const app = checkout(root, "app", "acme/app");
    const docs = checkout(root, "docs", "owner/docs");
    return { root, app, docs, done };
  } catch (error) {
    done();
    throw error;
  }
}

test("--with is read from each flag, up to 5, and PR-style parsing drops it", async () => {
  must(
    JSON.stringify(
      withFlagValues(["--with=../a", "--json", "--with=../b@x"]),
    ) === JSON.stringify(["../a", "../b@x"]),
    "two values",
  );
  const six = Array.from({ length: 6 }, (_, i) => `--with=../c${i}`);
  must(
    (await usageError(async () => withFlagValues(six))) ===
      "--with: at most 5 companions",
    "six",
  );
  must(
    (await usageError(async () => withFlagValues(["--with="]))).startsWith(
      "--with: give a path",
    ),
    "empty",
  );
  must(
    JSON.stringify(filterReviewConfigArgs(["--with=../a", "--token=x"])) ===
      JSON.stringify(["--token=x"]),
    "filtered",
  );
  const local = await parseReviewArgs(["--with=../a", "--with=../b"]);
  must(JSON.stringify(local.with) === '["../a","../b"]', "local keeps them");
  must(
    (await usageError(() =>
      parseReviewArgs([
        "--remote",
        `--range=${"a".repeat(40)}..${"b".repeat(40)}`,
        "--with=../a",
      ]),
    )) === "--with is not supported with --range",
    "range",
  );
});

test("PATH@BRANCH splits at the last @, unless the whole value is a folder", () => {
  const w = world();
  try {
    must(
      JSON.stringify(splitWithValue("../docs@feature/a", w.app)) ===
        '{"path":"../docs","branch":"feature/a"}',
      "split",
    );
    mkdirSync(join(w.root, "odd@name"));
    must(
      JSON.stringify(splitWithValue("../odd@name", w.app)) ===
        '{"path":"../odd@name"}',
      "a folder with @",
    );
    must(splitWithValue("../docs", w.app).branch === undefined, "no branch");
  } finally {
    w.done();
  }
});

test("each case of the flag table is exit 2 with its message", async () => {
  const w = world();
  try {
    const plain = join(w.root, "plain");
    mkdirSync(plain);
    const reviewed = { repo: "acme/app", root: w.app };
    const load = (
      values: string[],
      who: { repo: string; root?: string } = reviewed,
    ) => loadCompanions(values, who, undefined, w.app);
    must(
      (await usageError(() => load(["../plain"]))) ===
        "--with: ../plain is not a git repository",
      "plain folder",
    );
    must(
      (await usageError(() => load(["../missing"]))) ===
        "--with: ../missing is not a git repository",
      "missing folder",
    );
    must(
      (await usageError(() => load(["../docs@nope"]))) ===
        "--with: no branch nope in owner/docs",
      "no branch",
    );
    must(
      (await usageError(() => load(["."]))) ===
        "--with: . is the repository under review",
      "same root",
    );
    // Another clone of the reviewed repository, as a pull request review
    // sees it: the same name from its remote.
    const clone = checkout(w.root, "clone", "acme/app");
    must(
      (await usageError(() => load([clone], { repo: "ACME/app" }))) ===
        `--with: ${clone} is the repository under review`,
      "same repository",
    );
    must(
      (await usageError(() => load(["../docs", "../docs@main"]))) ===
        "--with: owner/docs is given more than once",
      "twice",
    );
  } finally {
    w.done();
  }
});

test("without @BRANCH the companion's branch and working tree are read", async () => {
  const w = world();
  try {
    git(w.docs, ["switch", "-q", "-c", "feature/session"]);
    writeFileSync(join(w.docs, "api.md"), "The session opens itself.\n");
    git(w.docs, ["add", "-A"]);
    git(w.docs, ["commit", "-q", "-m", "docs"]);
    writeFileSync(join(w.docs, "README.md"), "# readme\nedited\n");
    writeFileSync(join(w.docs, "new.md"), "untracked\n");
    const [docs] = await loadCompanions(
      ["../docs"],
      { repo: "acme/app", root: w.app },
      undefined,
      w.app,
    );
    must(docs!.repo === "owner/docs", docs!.repo);
    must(docs!.branch === "feature/session", docs!.branch);
    must(docs!.private, "private until read");
    must(
      docs!.files.map((f) => f.path).join(",") === "api.md,new.md,README.md",
      docs!.files.map((f) => f.path).join(","),
    );
  } finally {
    w.done();
  }
});

test("with @BRANCH the branch is diffed against its merge base, and the checkout is left as it was", async () => {
  const w = world();
  try {
    git(w.docs, ["switch", "-q", "-c", "feature/session"]);
    writeFileSync(join(w.docs, "api.md"), "The session opens itself.\n");
    git(w.docs, ["add", "-A"]);
    git(w.docs, ["commit", "-q", "-m", "docs"]);
    git(w.docs, ["switch", "-q", "main"]);
    writeFileSync(join(w.docs, "README.md"), "# readme\nwork in progress\n");
    const before = {
      head: git(w.docs, ["rev-parse", "HEAD"]),
      branch: git(w.docs, ["branch", "--show-current"]),
      status: git(w.docs, ["status", "--porcelain"]),
    };
    const [docs] = await loadCompanions(
      ["../docs@feature/session"],
      { repo: "acme/app", root: w.app },
      undefined,
      w.app,
    );
    must(docs!.branch === "feature/session", docs!.branch);
    must(
      docs!.files.map((f) => f.path).join(",") === "api.md",
      "only the branch's commit, never the working tree",
    );
    const after = {
      head: git(w.docs, ["rev-parse", "HEAD"]),
      branch: git(w.docs, ["branch", "--show-current"]),
      status: git(w.docs, ["status", "--porcelain"]),
    };
    must(JSON.stringify(after) === JSON.stringify(before), "untouched");
    const [main] = await loadCompanions(
      ["../docs@main"],
      { repo: "acme/app", root: w.app },
      undefined,
      w.app,
    );
    must(main!.files.length === 0, "no change on the default branch");
  } finally {
    w.done();
  }
});

test("a companion is private unless GitHub says it is public, or the reviewed repository is private", async () => {
  const base: Companion = {
    repo: "owner/docs",
    branch: "main",
    files: [],
    private: true,
  };
  const client = (answers: Record<string, unknown>) => ({
    request: async <T>(path: string): Promise<T> => {
      const repo = path.replace(/^repos\//, "");
      if (!(repo in answers)) throw new Error("404");
      return answers[repo] as T;
    },
  });
  const read = async (answers: Record<string, unknown>) =>
    (await readCompanionVisibility([base], "acme/app", client(answers)))[0]!
      .private;
  must(
    (await read({
      "acme/app": { private: false },
      "owner/docs": { private: true },
    })) === true,
    "private companion, public review",
  );
  must(
    (await read({
      "acme/app": { private: false },
      "owner/docs": { private: false },
    })) === false,
    "public companion",
  );
  must((await read({ "acme/app": { private: false } })) === true, "unreadable");
  must(
    (await read({
      "acme/app": { private: true },
      "owner/docs": { private: true },
    })) === false,
    "a private review quotes its private companion",
  );
  must((await read({})) === true, "nothing readable");
  must(
    (await readCompanionVisibility([base], "acme/app", undefined))[0]!.private,
    "no client",
  );
});
