import { normalizeAnchor, normalizeBody } from "./revision.ts";

Deno.test("carry_over: crlf body equal", () => {
  const a = "@@ -1,2 +1,2 @@\n-old\r\n+new\r\n";
  const b = "@@ -1,2 +1,2 @@\n-old\n+new\n";
  if (normalizeBody(a) !== normalizeBody(b)) {
    throw new Error("CRLF and LF patches should normalize the same");
  }
});

Deno.test("carry_over: whitespace insensitive anchor", () => {
  const a = "  foo   bar  \n  baz ";
  const b = "foo bar\nbaz";
  if (normalizeAnchor(a) !== normalizeAnchor(b)) {
    throw new Error("anchors should ignore extra whitespace");
  }
});
