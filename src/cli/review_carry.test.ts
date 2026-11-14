/** Which paths a run saves as seen, for both local and pull request review. */
import { test } from "node:test";
import { finishCarryRun, startCarryRun } from "./review_carry.ts";
import type { Revision, RevisionFile } from "../review/revision.ts";

function file(path: string, body: string, extra?: Partial<RevisionFile>) {
  return {
    path,
    previousPath: null,
    status: "modified",
    binary: false,
    additions: 1,
    deletions: 0,
    patch: `@@ -0,0 +1,1 @@\n+${body}`,
    ...extra,
  } as RevisionFile;
}

function revision(files: RevisionFile[]): Revision {
  return {
    files,
    title: "",
    description: "",
    baseLabel: "origin/main",
    producer: "github",
  };
}

/** The previous run saw a.ts, b.ts and c.ts. */
const PREVIOUS_FILES = [
  file("a.ts", "a"),
  file("b.ts", "b"),
  file("c.ts", "c"),
];
const previous = {
  files: PREVIOUS_FILES,
  visiblePaths: ["a.ts", "b.ts", "c.ts"],
  findings: [],
  guideBuiltAt: "2026-01-01T00:00:00.000Z",
};

function saved(current: RevisionFile[], seenThisRun: string[]): string[] {
  const rev = revision(current);
  const run = startCarryRun(previous, rev, previous.guideBuiltAt);
  const result = finishCarryRun(run, rev, {
    text: "",
    visiblePaths: seenThisRun,
    guideBuiltAt: previous.guideBuiltAt,
  });
  return [...result.visiblePaths].sort();
}

test("an unchanged file stays seen after a run that did not show it", () => {
  // Only b.ts changed, so only b.ts was shown. a.ts and c.ts were judged
  // before and have not changed since.
  const got = saved(
    [file("a.ts", "a"), file("b.ts", "b2"), file("c.ts", "c")],
    ["b.ts"],
  );
  if (got.join() !== "a.ts,b.ts,c.ts") throw new Error(got.join());
});

test("a file that left the diff is no longer seen", () => {
  const got = saved([file("a.ts", "a"), file("b.ts", "b")], []);
  if (got.join() !== "a.ts,b.ts") throw new Error(got.join());
});

test("a renamed file is seen under its new name only", () => {
  const got = saved(
    [
      file("a.ts", "a"),
      file("b.ts", "b"),
      file("d.ts", "c", { status: "renamed", previousPath: "c.ts" }),
    ],
    ["d.ts"],
  );
  if (got.join() !== "a.ts,b.ts,d.ts") throw new Error(got.join());
});

test("a file that changed but was withheld from the model is not seen", () => {
  const got = saved(
    [file("a.ts", "a"), file("b.ts", "b2"), file("c.ts", "c")],
    [],
  );
  if (got.join() !== "a.ts,c.ts") throw new Error(got.join());
});

test("a file the earlier run never saw is not made seen by being unchanged", () => {
  const rev = revision([file("a.ts", "a"), file("u.ts", "u")]);
  const run = startCarryRun(
    {
      ...previous,
      files: [file("a.ts", "a"), file("u.ts", "u")],
      visiblePaths: ["a.ts"],
    },
    rev,
    previous.guideBuiltAt,
  );
  const result = finishCarryRun(run, rev, {
    text: "",
    visiblePaths: [],
    guideBuiltAt: previous.guideBuiltAt,
  });
  if ([...result.visiblePaths].join() !== "a.ts") {
    throw new Error([...result.visiblePaths].join());
  }
});

test("a first run saves exactly what the model saw", () => {
  const rev = revision([file("a.ts", "a")]);
  const run = startCarryRun(null, rev, null);
  const result = finishCarryRun(run, rev, {
    text: "",
    visiblePaths: ["a.ts"],
    guideBuiltAt: null,
  });
  if ([...result.visiblePaths].join() !== "a.ts") {
    throw new Error([...result.visiblePaths].join());
  }
});
