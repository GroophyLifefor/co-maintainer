import {
  incrementalBase,
  matchRepeat,
  reviewRounds,
  spansOverlap,
} from "./rounds.ts";
import type { FindingRow } from "../store/rows.ts";

Deno.test("reviewRounds clusters comments by original_commit_id in time order", () => {
  const rounds = reviewRounds([
    { original_commit_id: "b", created_at: "2026-01-02T00:00:00.000Z" },
    { original_commit_id: "a", created_at: "2026-01-01T00:00:00.000Z" },
    { original_commit_id: "a", created_at: "2026-01-01T01:00:00.000Z" },
    { original_commit_id: "c", created_at: "2026-01-03T00:00:00.000Z" },
  ]);
  if (rounds.join(",") !== "a,b,c") {
    throw new Error(`rounds ${rounds.join(",")}`);
  }
});

Deno.test("incrementalBase is the previous clustered commit, not the current head", () => {
  if (incrementalBase(["sha1", "sha2"], "sha2") !== "sha1") {
    throw new Error("expected sha1");
  }
  if (incrementalBase(["sha1"], "sha1") !== undefined) {
    throw new Error("a single round has no incremental base");
  }
});

Deno.test("matchRepeat pairs a finding to the earlier thread on the same lines", () => {
  const previous: FindingRow[] = [{
    id: "old",
    review_id: "rev-1",
    severity: "P2",
    path: "src/app.ts",
    line_from: 4,
    line_to: 4,
    title: "unused",
    body_md: "drop it",
    posted_comment_id: "c-1",
    thread_comment_id: null,
    first_seen_review_id: null,
  }];
  const hit = matchRepeat({ path: "src/app.ts", from: 4, to: 4 }, previous);
  if (hit?.id !== "old" || hit.posted_comment_id !== "c-1") {
    throw new Error(JSON.stringify(hit));
  }
  const miss = matchRepeat({ path: "src/other.ts", from: 1, to: 1 }, previous);
  if (miss) throw new Error("other path should not match");
  if (
    !spansOverlap({ path: "./src/app.ts", from: 3, to: 5 }, {
      path: "src/app.ts",
      from: 4,
      to: 4,
    })
  ) {
    throw new Error("expected overlap across a dotted path");
  }
});
