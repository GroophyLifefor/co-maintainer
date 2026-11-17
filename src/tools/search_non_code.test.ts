/** `search-non-code` (issue 79): tracked text files codegraph does not parse,
 * never an untracked file, a binary file or an instruction file, with its
 * limits on matches, line length, context and regex time. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  grepArgs,
  type GrepRun,
  searchMaxContextLines,
  searchNonCode,
  SEARCH_REGEX_TIMEOUT_MS,
  type SearchOptions,
} from "./search_non_code.ts";
import { CODEGRAPH_EXTENSIONS } from "./codegraph.ts";
import { DEFAULT_AGENT_INSTRUCTIONS } from "../knowledge/instruction_files.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

/** A repository with `tracked` committed and `untracked` only on disk. */
function repo(
  tracked: Record<string, string | Buffer>,
  untracked: Record<string, string> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "cm-search-"));
  dirs.push(dir);
  git(dir, ["init", "-q"]);
  const write = (files: Record<string, string | Buffer>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  write(tracked);
  git(dir, ["add", "-A"]);
  write(untracked);
  return dir;
}

const OPTIONS: SearchOptions = {
  maxContextLines: 3,
  instructions: new RegExp(DEFAULT_AGENT_INSTRUCTIONS),
};

test("only tracked text files codegraph does not parse are searched", async () => {
  const dir = repo(
    {
      "docs/operations.md":
        "# Ops\nRoutes without an entry in RATE_LIMIT are not limited.\n",
      "deploy/compose.yml": 'services:\n  api:\n    RATE_LIMIT: "60"\n',
      "src/limit.ts": "export const RATE_LIMIT = 60;\n",
      "src/Limit.PY": "RATE_LIMIT = 60\n",
      "AGENTS.md": "Never change RATE_LIMIT.\n",
      "assets/blob.bin": Buffer.from("RATE_LIMIT\0\0binary"),
    },
    { ".env": "RATE_LIMIT=1\n", "notes.md": "RATE_LIMIT draft\n" },
  );
  const out = await searchNonCode(dir, { pattern: "RATE_LIMIT" }, OPTIONS);
  assert.equal(
    out,
    [
      'deploy/compose.yml:3:     RATE_LIMIT: "60"',
      "docs/operations.md:2: Routes without an entry in RATE_LIMIT are not limited.",
      "2 matches in 2 files",
    ].join("\n"),
  );
});

test("path limits the search to a folder or a file", async () => {
  const dir = repo({
    "docs/a.md": "TOKEN here\n",
    "deploy/b.yml": "TOKEN: x\n",
  });
  const out = await searchNonCode(
    dir,
    { pattern: "TOKEN", path: "docs/" },
    OPTIONS,
  );
  assert.equal(out, "docs/a.md:1: TOKEN here\n1 match in 1 file");
  const one = await searchNonCode(
    dir,
    { pattern: "TOKEN", path: "deploy/b.yml" },
    OPTIONS,
  );
  assert.match(one, /^deploy\/b\.yml:1: TOKEN: x\n1 match in 1 file$/);
  assert.match(
    await searchNonCode(dir, { pattern: "TOKEN", path: "nope" }, OPTIONS),
    /^No matches in the tracked files codegraph does not index under nope\.$/,
  );
});

test("a path outside the repository is refused before git runs", async () => {
  let ran = false;
  const run: GrepRun = () => {
    ran = true;
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
  };
  for (const path of ["../x", "/etc", "-x"]) {
    const out = await searchNonCode(
      ".",
      { pattern: "a", path },
      { ...OPTIONS, run },
    );
    assert.match(out, /^Tool error: /);
  }
  assert.match(
    await searchNonCode(".", { pattern: "a", other: 1 }, { ...OPTIONS, run }),
    /unknown key: other/,
  );
  assert.match(
    await searchNonCode(".", {}, { ...OPTIONS, run }),
    /requires 'pattern'/,
  );
  assert.equal(ran, false);
});

test("context lines come up to the repository's maximum and are marked apart from matches", async () => {
  const dir = repo({
    "docs/a.md": ["one", "two", "three", "KEY four", "five", "six"].join("\n"),
  });
  const out = await searchNonCode(
    dir,
    { pattern: "KEY", context: 10 },
    { ...OPTIONS, maxContextLines: 1 },
  );
  assert.equal(
    out,
    [
      "docs/a.md-3- three",
      "docs/a.md:4: KEY four",
      "docs/a.md-5- five",
      "1 match in 1 file",
    ].join("\n"),
  );
  assert.equal(searchMaxContextLines(undefined), 3);
  assert.equal(searchMaxContextLines({ reviewSearchMaxContextLines: 0 }), null);
});

test("at most 30 matches, each line cut at 200 characters, then the rest per file", async () => {
  const many = Array.from({ length: 35 }, (_, i) => `HIT ${i}`).join("\n");
  const dir = repo({
    "a.md": `HIT ${"x".repeat(300)}\n`,
    "b.md": many,
    "c.txt": "HIT\nHIT\n",
  });
  const out = await searchNonCode(dir, { pattern: "HIT" }, OPTIONS);
  const lines = out.split("\n");
  assert.equal(lines[0], `a.md:1: HIT ${"x".repeat(196)}...`);
  assert.equal(
    lines.filter((line) => /^[a-c]\.(md|txt):\d+: /.test(line)).length,
    30,
  );
  assert.equal(lines.at(-2), "and 8 more matches: b.md (6), c.txt (2)");
  assert.equal(lines.at(-1), "38 matches in 3 files");
});

test("literal search uses fixed strings, regex search is extended and time limited", async () => {
  const dir = repo({ "a.md": "port 48091\nport 4809x\n" });
  assert.equal(
    await searchNonCode(dir, { pattern: "4809[0-9]" }, OPTIONS),
    "No matches in the tracked files codegraph does not index.",
  );
  assert.equal(
    await searchNonCode(dir, { pattern: "4809[0-9]", regex: true }, OPTIONS),
    "a.md:1: port 48091\n1 match in 1 file",
  );
  assert.ok(
    grepArgs({ pattern: "x", regex: false, context: 0 }).includes(
      "--fixed-strings",
    ),
  );
  assert.ok(grepArgs({ pattern: "x", regex: true, context: 0 }).includes("-E"));
  const excluded = grepArgs({ pattern: "x", regex: false, context: 0 });
  for (const ext of CODEGRAPH_EXTENSIONS) {
    assert.ok(excluded.includes(`:(exclude,icase,glob)**/*${ext}`), ext);
  }

  const limits: (number | null)[] = [];
  const slow: GrepRun = (_args, _cwd, timeoutMs) => {
    limits.push(timeoutMs);
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "",
      timedOut: timeoutMs !== null,
    });
  };
  const timedOut = await searchNonCode(
    dir,
    { pattern: "(a+)+b", regex: true },
    { ...OPTIONS, run: slow },
  );
  assert.equal(
    timedOut,
    "Search timed out after 5 seconds. Use a simpler pattern or a narrower path.",
  );
  await searchNonCode(dir, { pattern: "plain" }, { ...OPTIONS, run: slow });
  assert.deepEqual(limits, [SEARCH_REGEX_TIMEOUT_MS, null]);
});

test("a regex git cannot read is reported as a tool error", async () => {
  const dir = repo({ "a.md": "x\n" });
  assert.match(
    await searchNonCode(dir, { pattern: "(", regex: true }, OPTIONS),
    /^Tool error: search failed: /,
  );
});
