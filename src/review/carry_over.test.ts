import {
  buildCarryPromptSection,
  findingsMarkdownForParse,
  guideRebuiltSince,
  incrementalDiffPaths,
  parsePreviousVerdicts,
  type CarryItem,
  type StoredFinding,
} from "./carry_over.ts";
import type { Revision } from "./revision.ts";
import { test } from "node:test";

test("carry_over: parse previous verdict lines", () => {
  const text = `## Findings
- something

## Previous findings
- F1: closed
- F2: open src/app.ts:4-6
`;
  const verdicts = parsePreviousVerdicts(text);
  if (verdicts.length !== 2 || verdicts[0].state !== "closed") {
    throw new Error(JSON.stringify(verdicts));
  }
  if (verdicts[1].path !== "src/app.ts" || verdicts[1].from !== 4) {
    throw new Error(JSON.stringify(verdicts[1]));
  }
});

test("carry_over: strip previous findings before parse", () => {
  const md = "## Findings\n- [P2] bug\n\n## Previous findings\n- F1: closed\n";
  const cut = findingsMarkdownForParse(md);
  if (cut.includes("Previous findings")) {
    throw new Error("section should be removed for parsing");
  }
});

test("guideRebuiltSince: a newer guide build invalidates carry-over", () => {
  if (!guideRebuiltSince("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")) {
    throw new Error("a newer guide build must count as rebuilt");
  }
  if (guideRebuiltSince("2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z")) {
    throw new Error("an older guide build is not a rebuild");
  }
  if (guideRebuiltSince("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")) {
    throw new Error("the same build is not a rebuild");
  }
});

test("guideRebuiltSince: silence is not a rebuild", () => {
  // No current build time at all: nothing to compare, so carry-over stays.
  if (guideRebuiltSince("2026-01-01T00:00:00Z", null)) {
    throw new Error("a missing current build must not force fresh");
  }
  // A previous snapshot with no recorded build time is treated as stale, so
  // the first run after this change re-scans once instead of trusting old verdicts.
  if (!guideRebuiltSince(null, "2026-01-01T00:00:00Z")) {
    throw new Error("a previous record without a build time must force fresh");
  }
  if (guideRebuiltSince(null, null)) {
    throw new Error("nothing known on either side is not a rebuild");
  }
});

test("guideRebuiltSince: an unparseable timestamp falls back to inequality", () => {
  if (!guideRebuiltSince("not-a-date", "2026-01-01T00:00:00Z")) {
    throw new Error("different unparseable stamps must count as changed");
  }
  if (guideRebuiltSince("not-a-date", "not-a-date")) {
    throw new Error("identical unparseable stamps are not a change");
  }
});

function finding(overrides: Partial<StoredFinding> = {}): StoredFinding {
  return {
    id: "f1",
    path: "src/a.ts",
    lineFrom: 4,
    lineTo: 4,
    title: "the helper ignores its argument",
    bodyMd: "It never reads the value.",
    anchorText: "const x = 1",
    severity: "P2",
    firstSeenReviewId: null,
    ...overrides,
  };
}

function revisionWith(path: string, patch: string): Revision {
  return {
    files: [
      {
        path,
        previousPath: null,
        status: "modified",
        binary: false,
        additions: 1,
        deletions: 1,
        patch,
      },
    ],
    title: "t",
    description: "",
    baseLabel: "main",
    producer: "local",
  };
}

test("buildCarryPromptSection: asks for a fresh scan as well as the verdicts", () => {
  const item: CarryItem = {
    id: "f1",
    finding: finding(),
    class: "verify_present",
    targetPath: "src/a.ts",
    lineFrom: 4,
    lineTo: 4,
  };
  const section = buildCarryPromptSection(
    [item],
    revisionWith("src/a.ts", "@@ -1 +1 @@\n-const x = 0\n+const x = 1"),
  );
  // The fix: the prompt must say the whole diff is still scanned, not just
  // that the previous finding is re-checked.
  if (!/Scan the DIFF from scratch/i.test(section)) {
    throw new Error(`no fresh-scan instruction:\n${section}`);
  }
  if (!/two separate jobs/i.test(section)) {
    throw new Error(`jobs are not separated:\n${section}`);
  }
  // And the verdict contract must survive the rewrite.
  if (!/## Previous findings/.test(section) || !/- F1: open/.test(section)) {
    throw new Error(`verdict contract changed:\n${section}`);
  }
  if (!section.includes("F1 · still present in changed code")) {
    throw new Error(`verify entry missing:\n${section}`);
  }
});

test("buildCarryPromptSection: no carry items means no section", () => {
  const section = buildCarryPromptSection([], revisionWith("src/a.ts", ""));
  if (section !== "") throw new Error(`expected empty, got:\n${section}`);
});

function twoFiles(): Revision {
  const base = revisionWith("src/a.ts", "@@ -1 +1 @@\n-a\n+b");
  return {
    ...base,
    files: [
      ...base.files,
      { ...base.files[0]!, path: "src/z.ts", patch: "@@ -1 +1 @@\n-y\n+z" },
    ],
  };
}

test("incrementalDiffPaths: an unchanged file outside the seen set is sent again", () => {
  const current = twoFiles();
  // Last round dropped src/z.ts: same patch, but the model never received it.
  const { changed, unchanged } = incrementalDiffPaths(
    current,
    current.files,
    new Set(["src/a.ts"]),
  );
  if (JSON.stringify(unchanged) !== JSON.stringify(["src/a.ts"])) {
    throw new Error(`unchanged: ${JSON.stringify(unchanged)}`);
  }
  if (changed.map((file) => file.path).join() !== "src/z.ts") {
    throw new Error(`changed: ${changed.map((file) => file.path).join()}`);
  }
});

test("incrementalDiffPaths: a seen file with a new patch is still sent", () => {
  const current = twoFiles();
  const previous = current.files.map((file) =>
    file.path === "src/a.ts" ? { ...file, patch: "@@ -1 +1 @@\n-a\n+c" } : file,
  );
  const { unchanged } = incrementalDiffPaths(
    current,
    previous,
    new Set(["src/a.ts", "src/z.ts"]),
  );
  if (JSON.stringify(unchanged) !== JSON.stringify(["src/z.ts"])) {
    throw new Error(`unchanged: ${JSON.stringify(unchanged)}`);
  }
});

test("the seen set carries forward: a dropped file is covered in the next round and then stays covered", () => {
  const current = twoFiles();
  // Round 1: src/z.ts was dropped, so only src/a.ts was seen.
  const round1Seen = new Set(["src/a.ts"]);
  const round2 = incrementalDiffPaths(current, current.files, round1Seen);
  if (round2.changed.map((file) => file.path).join() !== "src/z.ts") {
    throw new Error("round 2 must send the dropped file");
  }
  // Round 2 sends src/z.ts in full. Its seen set is what it received plus
  // the unchanged files it carried, which is what the reviewer stores.
  const round2Seen = new Set([
    ...round2.changed.map((file) => file.path),
    ...round2.unchanged,
  ]);
  const round3 = incrementalDiffPaths(current, current.files, round2Seen);
  if (round3.changed.length !== 0) {
    throw new Error(
      `round 3 has nothing new: ${round3.changed.map((f) => f.path).join()}`,
    );
  }
});
