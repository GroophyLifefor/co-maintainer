/** A repository's review exclude pattern drops files before the diff is
 * built, the model is told how many, and the Metadata block says so. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyExclude,
  excludedPromptNote,
  excludePatternError,
} from "./exclude.ts";
import { excludedMetadataLine } from "../services/review.ts";

const FILES = [
  { filename: "src/app.ts" },
  { filename: "vendor/lib.js" },
  { filename: "internal/loader/cheat-files/aix.yaml" },
  { filename: "src/new.ts", previous_filename: "vendor/old.ts" },
];

test("matching paths are dropped and counted", () => {
  const { kept, excluded } = applyExclude(FILES, "^vendor/|cheat-files/");
  assert.deepEqual(
    kept.map((file) => file.filename),
    ["src/app.ts"],
  );
  // The rename counts: its old path is under vendor/.
  assert.equal(excluded, 3);
});

test("no pattern or a blank one keeps every file", () => {
  assert.equal(applyExclude(FILES, undefined).kept.length, 4);
  assert.equal(applyExclude(FILES, "  ").kept.length, 4);
});

test("a pattern that does not compile keeps every file and says why", () => {
  const warnings: string[] = [];
  const { kept, excluded } = applyExclude(FILES, "(", (message) =>
    warnings.push(message),
  );
  assert.equal(kept.length, 4);
  assert.equal(excluded, 0);
  assert.equal(warnings.length, 1);
});

test("saving checks the pattern compiles, blank is allowed", () => {
  assert.equal(excludePatternError("^dist/"), undefined);
  assert.equal(excludePatternError(""), undefined);
  assert.match(
    excludePatternError("(") ?? "",
    /not a valid regular expression/,
  );
});

test("the prompt note names the count and is empty when nothing was dropped", () => {
  assert.equal(excludedPromptNote(0), "");
  assert.match(excludedPromptNote(1), /1 changed file matched/);
  assert.match(excludedPromptNote(12), /12 changed files matched/);
});

test("the Metadata line shows the count and a safe pattern", () => {
  assert.equal(
    excludedMetadataLine({ count: 12, pattern: "^vendor/" }),
    "- Excluded: 12 files matching `^vendor/`\n",
  );
  // A backtick in the pattern cannot close the code span early.
  assert.ok(
    !excludedMetadataLine({ count: 1, pattern: "a`b" }).includes("a`b"),
  );
});
