import { test } from "node:test";
import {
  coverageFromPlan,
  cutAtLine,
  diffFileFromGithub,
  diffFileFromRevision,
  byPath,
  dropUntilFits,
  MAX_FILE_PATCH_CHARS,
  MAX_LISTED_FILES,
  MAX_REVIEW_DIFF_CHARS,
  notShownBlock,
  planDiff,
  renderSection,
  seenPaths,
  type DiffFile,
  type FileState,
  type PlannedFile,
} from "./diff_plan.ts";
import type { RevisionFile } from "../review/revision.ts";
import { coverageTruncated } from "../review/coverage.ts";

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

function contains(haystack: string, needle: string, what: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${what}: ${JSON.stringify(haystack)} lacks ${needle}`);
  }
}

/** A file of `lines` added lines, each `width` characters long. */
function file(path: string, lines: number, width = 40): DiffFile {
  const body = Array.from(
    { length: lines },
    (_, i) => `+${String(i).padEnd(width - 1, "x")}`,
  );
  return {
    path,
    previousPath: null,
    status: "modified",
    additions: lines,
    deletions: 0,
    changes: lines,
    patch: `@@ -0,0 +1,${lines} @@\n${body.join("\n")}`,
  };
}

function states(planned: PlannedFile[]): Record<string, FileState> {
  return Object.fromEntries(planned.map((item) => [item.path, item.state]));
}

function joinedLength(planned: PlannedFile[]): number {
  return planned
    .filter((item) => item.state !== "dropped")
    .map((item) =>
      renderSection(item, { tools: true, summary: "x".repeat(700) }),
    )
    .join("\n\n").length;
}

test("a diff that fits stays full", () => {
  const planned = planDiff([file("a.ts", 10), file("b.ts", 20)]);
  same(states(planned), { "a.ts": "full", "b.ts": "full" }, "states");
});

test("a file over 500 changed lines is summarized, as before", () => {
  const planned = planDiff([file("a.ts", 501, 10), file("b.ts", 10)]);
  same(states(planned), { "a.ts": "summarized", "b.ts": "full" }, "states");
});

test("a patch over 12,000 characters is partial", () => {
  const planned = planDiff([file("big.ts", 400, 40)]);
  same(states(planned), { "big.ts": "partial" }, "states");
  const rendered = renderSection(planned[0]!, { tools: true });
  contains(rendered, "cut off here", "marker");
  contains(rendered, "400 changed lines total", "counts");
  contains(rendered, 'read-full-diff with path "big.ts" and offset=', "next");
  // The limit counts patch characters. The rendered block adds a 7 character
  // line-number gutter to each of the 300 or so lines shown, and the marker.
  if (rendered.length > MAX_FILE_PATCH_CHARS + 2_500) {
    throw new Error(`expected the patch trimmed, got ${rendered.length}`);
  }
});

test("the partial marker names the offset of the first line not shown", () => {
  const big = file("big.ts", 400, 40);
  const shown = cutAtLine(big.patch);
  const offset = shown.split("\n").length;
  if (!big.patch.split("\n")[offset]?.startsWith("+")) {
    throw new Error("the offset must point at a real diff line");
  }
  const rendered = renderSection({ ...big, state: "partial" }, { tools: true });
  contains(rendered, `offset=${offset}`, "offset");
  if (!shown.endsWith(big.patch.split("\n")[offset - 1]!)) {
    throw new Error("the cut must end on a whole line");
  }
});

test("over budget, the largest file is summarized first", () => {
  // 25 files of about 11,000 characters each is well over 240,000.
  const files = Array.from({ length: 25 }, (_, i) =>
    file(`f${String(i).padStart(2, "0")}.ts`, 250, 40),
  );
  files.push(file("huge.ts", 300, 40));
  const planned = planDiff(files);
  if (states(planned)["huge.ts"] !== "summarized") {
    throw new Error(`the largest file was not summarized first`);
  }
  if (planned.some((item) => item.state === "dropped")) {
    throw new Error("summaries were enough, nothing should be dropped");
  }
  if (joinedLength(planned) > MAX_REVIEW_DIFF_CHARS) {
    throw new Error(`still over budget: ${joinedLength(planned)}`);
  }
  const full = planned.filter((item) => item.state === "full").length;
  if (full === 0) throw new Error("the plan summarized more than it needed");
});

test("when summaries are not enough, files are dropped from the end of path order", () => {
  // 500 small files: each one is already smaller than its summary would be,
  // so only dropping can make them fit.
  const files = Array.from({ length: 500 }, (_, i) =>
    file(`src/f${String(i).padStart(3, "0")}.ts`, 8, 60),
  );
  // Input order is not path order: the plan must drop by path.
  files.reverse();
  const planned = planDiff(files);
  if (planned.some((item) => item.state === "summarized")) {
    throw new Error("summarizing a small file only grows the total");
  }
  const dropped = planned
    .filter((item) => item.state === "dropped")
    .map((item) => item.path)
    .sort();
  if (dropped.length === 0) throw new Error("expected dropped files");
  const kept = planned
    .filter((item) => item.state === "full")
    .map((item) => item.path)
    .sort();
  if (kept.at(-1)! >= dropped[0]!) {
    throw new Error("a later path was kept while an earlier one was dropped");
  }
  if (joinedLength(planned) > MAX_REVIEW_DIFF_CHARS) {
    throw new Error(`still over budget: ${joinedLength(planned)}`);
  }
  same(
    planned.map((item) => item.path),
    files.map((item) => item.path),
    "input order is kept",
  );
});

test("a file GitHub sent no patch for is withheld, and says so", () => {
  const github = diffFileFromGithub({
    filename: "pnpm-lock.yaml",
    status: "modified",
    changes: 1133,
    additions: 900,
    deletions: 233,
  });
  const [planned] = planDiff([github]);
  same(planned!.state, "withheld", "state");
  const rendered = renderSection(planned!, { tools: true });
  contains(rendered, "1133 changed lines", "counts");
  contains(rendered, "+900 -233", "split");
  contains(rendered, "withheld by GitHub", "reason");
  contains(rendered, "Do not treat this file as unchanged", "instruction");
});

test("a pure rename on GitHub is full, not withheld", () => {
  const renamed = diffFileFromGithub({
    filename: "src/new.ts",
    previous_filename: "src/old.ts",
    status: "renamed",
    additions: 0,
    deletions: 0,
    changes: 0,
  });
  const planned = planDiff([renamed]);
  same(states(planned), { "src/new.ts": "full" }, "state");
  const rendered = renderSection(planned[0]!, { tools: true });
  contains(rendered, "renamed without changes from src/old.ts", "label");
  if (rendered.includes("withheld")) throw new Error(rendered);
  same(coverageTruncated(coverageFromPlan(planned)), false, "not truncated");
  // A push review built from GitHub's compare API gets the same answer.
  const pushed = diffFileFromRevision(
    revisionFile({
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
    }),
    "github",
  );
  same(planDiff([pushed])[0]!.state, "full", "push revision");
  // A rename with changes but no patch is still withheld.
  const changed = diffFileFromGithub({
    filename: "big.min.js",
    previous_filename: "old.min.js",
    status: "renamed",
    changes: 4,
  });
  same(planDiff([changed])[0]!.state, "withheld", "renamed with changes");
});

test("a withheld file with no counts still says what is missing", () => {
  const [planned] = planDiff([
    diffFileFromGithub({ filename: "big.bin", status: "modified" }),
  ]);
  const rendered = renderSection(planned!, { tools: true });
  contains(rendered, "unreported number of changed lines", "fallback");
});

test("a present patch is numbered with new-file lines", () => {
  const [planned] = planDiff([
    diffFileFromGithub({
      filename: "a.ts",
      patch: "@@ -1,2 +1,3 @@\n context\n+added",
    }),
  ]);
  same(
    renderSection(planned!, { tools: true }),
    "FILE: a.ts\n@@ -1,2 +1,3 @@\n     1  context\n     2 +added",
    "rendered",
  );
});

function revisionFile(overrides: Partial<RevisionFile>): RevisionFile {
  return {
    path: "a.bin",
    previousPath: null,
    status: "modified",
    binary: false,
    additions: 0,
    deletions: 0,
    patch: "",
    ...overrides,
  };
}

test("local review labels a binary file and a pure rename instead of calling them withheld", () => {
  const binary = diffFileFromRevision(
    revisionFile({ path: "logo.png", binary: true }),
    "local",
  );
  const renamed = diffFileFromRevision(
    revisionFile({
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
    }),
    "remote",
  );
  const planned = planDiff([binary, renamed]);
  same(states(planned), { "logo.png": "full", "src/new.ts": "full" }, "full");
  const text = planned
    .map((item) => renderSection(item, { tools: true }))
    .join("\n");
  contains(text, "binary file", "binary label");
  contains(text, "renamed without changes from src/old.ts", "rename label");
  if (text.includes("withheld")) throw new Error(text);
  const pushed = diffFileFromRevision(
    revisionFile({ path: "lock.json" }),
    "github",
  );
  same(planDiff([pushed])[0]!.state, "withheld", "a GitHub revision");
});

test("without tool support the markers do not point at read-full-diff", () => {
  const big = { ...file("big.ts", 400, 40), state: "partial" as const };
  const partial = renderSection(big, { tools: false });
  contains(partial, "cannot be read in this review", "partial");
  const summarized = renderSection(
    { ...big, state: "summarized" },
    { tools: false, summary: "It adds rows." },
  );
  const dropped = notShownBlock([{ ...big, state: "dropped" }], {
    tools: false,
  });
  contains(dropped, "cannot call tools", "not shown");
  for (const text of [partial, summarized, dropped]) {
    if (text.includes("read-full-diff")) throw new Error(text);
  }
});

test("the NOT SHOWN list names each dropped file with its counts", () => {
  const block = notShownBlock(
    [
      { ...file("a.ts", 3), state: "dropped" },
      { ...file("b.ts", 3), state: "full" },
    ],
    { tools: true },
  );
  contains(block, "NOT SHOWN (diff budget)", "heading");
  contains(block, "- a.ts (+3 -0)", "entry");
  contains(block, "read-full-diff", "how to open");
  if (block.includes("b.ts")) throw new Error("a full file is not listed");
  same(
    notShownBlock([{ ...file("b.ts", 3), state: "full" }], { tools: true }),
    "",
    "none",
  );
});

test("drop order is plain code-point order, the same on every machine", () => {
  same(
    ["b.ts", "_x.ts", "a.ts", "C.ts"].sort(byPath),
    ["C.ts", "_x.ts", "a.ts", "b.ts"],
    "code points",
  );
  const planned: PlannedFile[] = ["b.ts", "_x.ts", "a.ts", "C.ts"].map(
    (path) => ({ ...file(path, 3), state: "full" }),
  );
  // Room for three of four and the NOT SHOWN list: the last in code-point
  // order goes.
  dropUntilFits(planned, () => 1_000, 3 * 1_000 + 2 * 2 + 500);
  same(
    planned.filter((item) => item.state === "dropped").map((item) => item.path),
    ["b.ts"],
    "dropped",
  );
});

test("the NOT SHOWN list names at most 200 files and counts in the budget", () => {
  const files = Array.from({ length: 20_000 }, (_, i) =>
    file(`src/f${String(i).padStart(5, "0")}.ts`, 1, 20),
  );
  const planned = planDiff(files);
  const block = notShownBlock(planned, { tools: true });
  const listed = block.split("\n").filter((line) => line.startsWith("- "));
  same(listed.length, MAX_LISTED_FILES + 1, "200 names and the rest");
  const dropped = planned.filter((item) => item.state === "dropped").length;
  same(
    listed.at(-1),
    `- and ${dropped - MAX_LISTED_FILES} more`,
    "the rest line",
  );
  const whole = `${planned
    .filter((item) => item.state !== "dropped")
    .map((item) => renderSection(item, { tools: true }))
    .join("\n\n")}\n\n${block}`;
  if (whole.length > MAX_REVIEW_DIFF_CHARS) {
    throw new Error(`over budget with the list: ${whole.length}`);
  }
});

test("dropUntilFits drops nothing when the diff fits", () => {
  const planned: PlannedFile[] = [{ ...file("a.ts", 3), state: "full" }];
  dropUntilFits(planned, () => 100, 1_000);
  same(planned[0]!.state, "full", "kept");
});

test("dropUntilFits never drops a withheld file", () => {
  const planned: PlannedFile[] = [
    { ...file("a.ts", 3), state: "full" },
    { ...file("z.ts", 3), state: "withheld" },
  ];
  dropUntilFits(planned, () => 600, 1_000);
  same(states(planned), { "a.ts": "dropped", "z.ts": "withheld" }, "states");
});

test("the seen set holds what the model received plus unchanged files", () => {
  const planned: PlannedFile[] = [
    { ...file("full.ts", 1), state: "full" },
    { ...file("partial.ts", 1), state: "partial" },
    { ...file("summary.ts", 1), state: "summarized" },
    { ...file("dropped.ts", 1), state: "dropped" },
    { ...file("withheld.ts", 1), state: "withheld" },
  ];
  same(
    seenPaths(planned, ["old.ts"]).sort(),
    ["full.ts", "old.ts", "partial.ts", "summary.ts"],
    "seen",
  );
  same(
    coverageFromPlan(planned, ["old.ts"]),
    {
      full: 2,
      partial: ["partial.ts"],
      summarized: ["summary.ts"],
      dropped: ["dropped.ts"],
      withheld: ["withheld.ts"],
    },
    "coverage",
  );
});
