import { test } from "node:test";
import { pathsSeenInRound, visiblePathsToSave } from "./visible_paths.ts";

function saved(
  previous: string[] | null | undefined,
  unchanged: string[] | undefined,
  seen: string[],
): string {
  return [...visiblePathsToSave(previous, unchanged, seen)].sort().join();
}

test("the seen paths are this run's plus the earlier ones still unchanged", () => {
  const got = saved(["a.ts", "b.ts", "c.ts"], ["a.ts", "c.ts"], ["b.ts"]);
  if (got !== "a.ts,b.ts,c.ts") throw new Error(got);
});

test("a path the earlier run did not see stays unseen", () => {
  const got = saved(["a.ts"], ["a.ts", "u.ts"], []);
  if (got !== "a.ts") throw new Error(got);
});

test("a path that is not unchanged this run is not carried", () => {
  const got = saved(["a.ts", "gone.ts"], ["a.ts"], []);
  if (got !== "a.ts") throw new Error(got);
});

test("paths compare after normalizing separators", () => {
  const got = saved(["src\\a.ts"], ["src/a.ts"], []);
  if (got !== "src\\a.ts") throw new Error(got);
});

test("no earlier run, or a round with no unchanged list, saves what was seen", () => {
  if (saved(null, ["a.ts"], ["b.ts"]) !== "b.ts") throw new Error("first run");
  if (saved(["a.ts"], undefined, ["b.ts"]) !== "b.ts") {
    throw new Error("whole-scope round");
  }
});

const ROUND = [
  { path: "full.ts", state: "full" },
  { path: "partial.ts", state: "partial" },
  { path: "summary.ts", state: "summarized" },
  { path: "dropped.ts", state: "dropped" },
  { path: "withheld.ts", state: "withheld" },
];

test("a dropped or withheld file never counts as seen", () => {
  const seen = pathsSeenInRound(ROUND);
  if (seen.sort().join() !== "full.ts,partial.ts,summary.ts") {
    throw new Error(seen.join());
  }
  // Seen in an earlier round, changed and dropped or withheld now: the file
  // is not unchanged, so the earlier sight is not carried either.
  const got = saved(["dropped.ts", "withheld.ts"], ["old.ts"], seen);
  if (got !== "full.ts,partial.ts,summary.ts") throw new Error(got);
});

test("a file skipped as unchanged stays seen, alongside what this round received", () => {
  const got = saved(["old.ts", "full.ts"], ["old.ts"], pathsSeenInRound(ROUND));
  if (got !== "full.ts,old.ts,partial.ts,summary.ts") throw new Error(got);
});
