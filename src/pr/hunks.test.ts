import { anchorFor, numberPatch, rightHunks } from "./hunks.ts";
import { test } from "node:test";

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

const TWO_HUNKS = [
  "@@ -1,3 +1,4 @@",
  " a",
  "+b",
  " c",
  " d",
  "@@ -20,2 +21,2 @@",
  "-old",
  "+new",
  " tail",
].join("\n");

test("rightHunks reads new file ranges and skips a deleted file", () => {
  same(
    rightHunks(TWO_HUNKS),
    [
      [1, 4],
      [21, 22],
    ],
    "two hunks",
  );
  same(rightHunks("@@ -1 +1 @@\n-a\n+b"), [[1, 1]], "count omitted");
  same(rightHunks("@@ -1,2 +0,0 @@\n-a\n-b"), [], "deleted file");
});

test("anchorFor keeps a span only when one hunk holds it", () => {
  same(anchorFor(TWO_HUNKS, 2, 4), { start_line: 2, line: 4 }, "fits");
  same(anchorFor(TWO_HUNKS, 3, 21), { line: 21 }, "split, end inside");
  same(anchorFor(TWO_HUNKS, 3, 15), { line: 3 }, "split, start inside");
  same(anchorFor(TWO_HUNKS, 10, 15), undefined, "outside");
  same(anchorFor(TWO_HUNKS, 22, 22), { line: 22 }, "single line");
  same(anchorFor(TWO_HUNKS, 4, 2), { start_line: 2, line: 4 }, "reversed");
  same(anchorFor("", 5, 9), { line: 9 }, "withheld patch");
});

test("numberPatch numbers new file lines and skips removed ones", () => {
  const patch = [
    "@@ -10,3 +12,3 @@ function a() {",
    " keep",
    "-gone",
    "+added",
    " tail",
    "\\ No newline at end of file",
    "@@ -40 +50,2 @@",
    "+first",
    "+second",
  ].join("\n");
  const expected = [
    "@@ -10,3 +12,3 @@ function a() {",
    "    12  keep",
    "       -gone",
    "    13 +added",
    "    14  tail",
    "       \\ No newline at end of file",
    "@@ -40 +50,2 @@",
    "    50 +first",
    "    51 +second",
  ].join("\n");
  const actual = numberPatch(patch);
  if (actual !== expected) {
    throw new Error(`numbered patch was\n${actual}`);
  }
});
