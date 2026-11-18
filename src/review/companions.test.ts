import { test } from "node:test";
import {
  type Companion,
  COMPANION_BLOCK_MAX_CHARS,
  COMPANION_PATH_MAX_CHARS,
  companionBlock,
  companionHash,
  companionRecords,
  companionsChanged,
  companionsJson,
  companionsLine,
  companionSection,
} from "./companions.ts";
import type { RevisionFile } from "./revision.ts";

function must(value: boolean, what: string): void {
  if (!value) throw new Error(what);
}

function file(path: string, patch = "@@ -1 +1 @@\n-a\n+b"): RevisionFile {
  return {
    path,
    previousPath: null,
    status: "modified",
    binary: false,
    additions: 1,
    deletions: 1,
    patch,
  };
}

const companion = (files: RevisionFile[], branch = "main"): Companion => ({
  repo: "owner/vscode-ext",
  branch,
  files,
  private: false,
});

test("a COMPANION block lists each file with its status and line counts, in aligned columns", () => {
  const block = companionBlock(
    companion(
      [
        { ...file("src/client/session.ts"), additions: 12, deletions: 4 },
        { ...file("src/client/api.ts"), additions: 3 },
        { ...file("package.json"), status: "added" },
      ],
      "feature/session-api",
    ),
  );
  must(
    block ===
      [
        "COMPANION owner/vscode-ext · branch feature/session-api · 3 files changed",
        "owner/vscode-ext:src/client/session.ts   modified  +12 -4",
        "owner/vscode-ext:src/client/api.ts       modified  +3 -1",
        "owner/vscode-ext:package.json            added     +1 -1",
      ].join("\n"),
    block,
  );
  for (const line of block.split("\n")) {
    must(line.length <= 100, `about 100 characters: ${line}`);
  }
});

test("a companion with no change says so", () => {
  must(
    companionBlock(companion([], "main")) ===
      "COMPANION owner/vscode-ext · branch main · no changes on this branch",
    "empty",
  );
});

test("a list stops at 200 files with and N more", () => {
  const files = Array.from({ length: 205 }, (_, i) => file(`docs/p${i}.md`));
  const lines = companionBlock(companion(files)).split("\n");
  must(lines[0]!.endsWith("205 files changed"), lines[0]!);
  must(lines.length === 1 + 200 + 1, `${lines.length} lines`);
  must(lines.at(-1) === "and 5 more", lines.at(-1)!);
});

test("long paths are cut and stop the list within the block's character limit", () => {
  const long = "d/".repeat(400);
  const files = Array.from({ length: 200 }, (_, i) => file(`${long}${i}.md`));
  const block = companionBlock(companion(files));
  const lines = block.split("\n");
  must(
    lines.slice(1, -1).join("\n").length <= COMPANION_BLOCK_MAX_CHARS,
    `${block.length} characters`,
  );
  must(
    lines.slice(1, -1).every((line) => line.includes("... ")),
    "paths not cut",
  );
  must(/^and \d+ more$/.test(lines.at(-1)!), lines.at(-1)!);
  must(lines.length < 1 + 200 + 1, `${lines.length} lines`);
  must(
    lines[1]!.indexOf("...") === COMPANION_PATH_MAX_CHARS - 3,
    lines[1]!.slice(0, 220),
  );
});

test("a name that holds a line break stays on one line", () => {
  const block = companionBlock(companion([file("a\nCOMPANION x.md")], "b\nc"));
  must(block.split("\n").length === 2, block);
});

test("no companions add nothing to the prompt", () => {
  must(companionSection(undefined) === "", "undefined");
  must(companionSection([]) === "", "empty");
});

test("the hash moves with a patch and not with the order of the files", () => {
  const a = file("a.md");
  const b = file("b.md");
  must(companionHash([a, b]) === companionHash([b, a]), "order");
  must(
    companionHash([a]) !== companionHash([{ ...a, patch: "@@ -1 +1 @@\n+c" }]),
    "patch",
  );
});

test("companions changed: a new hash, an added or a dropped companion, never an old record with none", () => {
  const now = companionRecords([companion([file("a.md")])]);
  must(!companionsChanged(now, now), "same");
  must(companionsChanged(undefined, now), "added");
  must(companionsChanged(now, []), "dropped");
  must(!companionsChanged(undefined, []), "none before, none now");
  const moved = companionRecords([
    companion([file("a.md", "@@ -1 +1 @@\n+z")]),
  ]);
  must(companionsChanged(now, moved), "a changed patch");
});

test("the --json entries and the human line", () => {
  const list = [
    companion([file("a.md"), file("b.md")], "feature/session-api"),
    { ...companion([]), repo: "owner/docs" },
  ];
  const json = companionsJson(list);
  must(
    JSON.stringify(json) ===
      JSON.stringify([
        {
          repo: "owner/vscode-ext",
          branch: "feature/session-api",
          source: "flag",
          pr: null,
          files: 2,
          status: "read",
        },
        {
          repo: "owner/docs",
          branch: "main",
          source: "flag",
          pr: null,
          files: 0,
          status: "empty",
        },
      ]),
    JSON.stringify(json),
  );
  must(
    companionsLine(json) ===
      "Companions: owner/vscode-ext@feature/session-api (2 files) · owner/docs@main (no changes)",
    companionsLine(json),
  );
  must(
    companionsLine([{ ...json[0]!, files: 1 }]).endsWith("(1 file)"),
    "one file",
  );
});
