import {
  normalizeAnchor,
  normalizeBody,
  revisionFilesEquivalent,
  type RevisionFile,
} from "./revision.ts";
import { test } from "node:test";

const file = (
  patch: string,
  overrides: Partial<RevisionFile> = {},
): RevisionFile => ({
  path: "a.ts",
  previousPath: null,
  status: "modified",
  binary: false,
  additions: 1,
  deletions: 0,
  patch,
  ...overrides,
});

test("carry_over: crlf body equal", () => {
  const a = "@@ -1,2 +1,2 @@\n-old\r\n+new\r\n";
  const b = "@@ -1,2 +1,2 @@\n-old\n+new\n";
  if (normalizeBody(a) !== normalizeBody(b)) {
    throw new Error("CRLF and LF patches should normalize the same");
  }
});

test("revisionFilesEquivalent: metadata change with same patch", () => {
  const a = file("", { additions: 0, deletions: 0, binary: true });
  const b = file("", { additions: 2, deletions: 0, binary: true });
  if (revisionFilesEquivalent(a, b)) {
    throw new Error("addition counts should differ");
  }
});

test("carry_over: whitespace insensitive anchor", () => {
  const a = "  foo   bar  \n  baz ";
  const b = "foo bar\nbaz";
  if (normalizeAnchor(a) !== normalizeAnchor(b)) {
    throw new Error("anchors should ignore extra whitespace");
  }
});
