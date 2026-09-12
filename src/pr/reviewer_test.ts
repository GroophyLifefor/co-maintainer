import { filePatch } from "./reviewer.ts";

function contains(haystack: string, needle: string, what: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${what}: ${JSON.stringify(haystack)} lacks ${needle}`);
  }
}

Deno.test("filePatch returns a present patch unchanged", () => {
  const patch = "@@ -1,2 +1,3 @@\n context\n+added";
  if (filePatch({ filename: "a.ts", patch }) !== patch) {
    throw new Error("expected the patch verbatim");
  }
});

Deno.test("filePatch says so when GitHub withheld the diff", () => {
  const rendered = filePatch({
    filename: "pnpm-lock.yaml",
    status: "modified",
    changes: 1133,
    additions: 900,
    deletions: 233,
  });
  contains(rendered, "1133 changed lines", "counts");
  contains(rendered, "+900 -233", "split");
  contains(rendered, "withheld by GitHub", "reason");
  contains(rendered, "Do not treat this file as unchanged", "instruction");
});

Deno.test("filePatch still reports a withheld file with no counts", () => {
  const rendered = filePatch({ filename: "big.bin", status: "modified" });
  contains(rendered, "unreported number of changed lines", "fallback");
  contains(rendered, "withheld by GitHub", "reason");
});

Deno.test("filePatch marks a per-file truncation", () => {
  const rendered = filePatch({
    filename: "huge.ts",
    status: "modified",
    changes: 5000,
    patch: "x".repeat(20_000),
  });
  contains(rendered, "cut off here", "marker");
  contains(rendered, "5000 changed lines total", "counts");
  if (rendered.length > 13_000) throw new Error("expected the patch trimmed");
});
