/** A changed companion rechecks carried findings, even when the reviewed
 * repository did not change at all. */
import { test } from "node:test";
import { finishCarryRun, startCarryRun } from "./review_carry.ts";
import type { Revision, RevisionFile } from "../review/revision.ts";

function must(value: boolean, what: string): void {
  if (!value) throw new Error(what);
}

const FILE: RevisionFile = {
  path: "src/session.ts",
  previousPath: null,
  status: "modified",
  binary: false,
  additions: 1,
  deletions: 1,
  patch:
    "@@ -1,2 +1,2 @@\n export const a = 1\n-export function startSession() {}\n+export function openSession() {}",
};

const revision: Revision = {
  files: [FILE],
  title: "",
  description: "",
  baseLabel: "origin/main",
  producer: "local",
};

const GUIDE = "2026-01-01T00:00:00.000Z";

const previous = {
  files: [FILE],
  visiblePaths: ["src/session.ts"],
  guideBuiltAt: GUIDE,
  findings: [
    {
      id: "f1",
      path: "src/session.ts",
      lineFrom: 2,
      lineTo: 2,
      title: "[P1 · blocking] `src/session.ts`",
      bodyMd: "startSession is gone, and the client still calls it.",
      anchorText: "export function openSession() {}",
      severity: "P1",
      firstSeenReviewId: null,
    },
  ],
};

test("an unchanged repository with unchanged companions sends nothing again", () => {
  const run = startCarryRun(previous, revision, GUIDE);
  must(
    JSON.stringify(run.extras.unchangedPaths) === '["src/session.ts"]',
    "the file is skipped as unchanged",
  );
  must(
    run.extras.carryPrompt!.includes(
      "file unchanged since the last review, the fix may be in another file",
    ),
    run.extras.carryPrompt!,
  );
  must(run.recheck === undefined, "no recheck");
});

test("a changed companion sends every file again and rechecks each carried finding", () => {
  const run = startCarryRun(previous, revision, GUIDE, true);
  must(
    JSON.stringify(run.extras.unchangedPaths) === "[]",
    "nothing is skipped",
  );
  must(
    run.extras.carryPrompt!.includes(
      "F1 · file unchanged since the last review, but a companion repository changed · src/session.ts:2",
    ),
    run.extras.carryPrompt!,
  );
  const closed = finishCarryRun(run, revision, {
    text: "## Findings\n\nNo actionable findings.\n\n## Previous findings\n\n- F1: closed",
    visiblePaths: ["src/session.ts"],
    guideBuiltAt: GUIDE,
  });
  must(
    closed.resolved.length === 1 && closed.resolved[0]!.state === "closed",
    JSON.stringify(closed.resolved),
  );
  const open = finishCarryRun(run, revision, {
    text: "## Findings\n\nNo actionable findings.\n\n## Previous findings\n\n- F1: open src/session.ts:2",
    visiblePaths: ["src/session.ts"],
    guideBuiltAt: GUIDE,
  });
  must(
    open.resolved[0]!.state === "open" && open.resolved[0]!.lineFrom === 2,
    JSON.stringify(open.resolved),
  );
});
