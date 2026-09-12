import { condense, selectFiles } from "./map.ts";

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

Deno.test("selectFiles takes the most changed source files first", () => {
  const { queried, skipped } = selectFiles([
    { path: "a.ts", changes: 5 },
    { path: "b.ts", changes: 90 },
    { path: "c.ts", changes: 40 },
  ], 2);
  same(queried, ["b.ts", "c.ts"], "order");
  same(skipped, [{ path: "a.ts", reason: "over the limit of 2" }], "skipped");
});

Deno.test("selectFiles puts priority files ahead of larger non-priority ones", () => {
  const { queried } = selectFiles(
    [
      { path: "upstream-huge.ts", changes: 900 },
      { path: "own-small.ts", changes: 4 },
      { path: "own-tiny.ts", changes: 1 },
    ],
    2,
    new Set(["own-small.ts", "own-tiny.ts"]),
  );
  same(
    queried,
    ["own-small.ts", "own-tiny.ts"],
    "own files fill the limit first",
  );
});

Deno.test("selectFiles skips files that carry no symbols", () => {
  const { queried, skipped } = selectFiles([
    { path: "pnpm-lock.yaml", changes: 1133 },
    { path: "CHANGELOG.md", changes: 12 },
    { path: "src/rule.ts", changes: 8 },
    { path: "snapshots/1-Error.shot", changes: 3 },
  ], 8);
  same(queried, ["src/rule.ts"], "only source");
  same(skipped.length, 3, "skipped count");
  for (const item of skipped) {
    same(item.reason, "not a source file", `reason for ${item.path}`);
  }
});

Deno.test("condense keeps the symbol map and drops the source listing", () => {
  const output = [
    "**src/rule.ts** — 2 symbols, used by 1 file: src/index.ts",
    "",
    "**Symbols**",
    "- `isSafeUse` (function) (node: Node): boolean — :390",
    "- `Config` (interface) — :19",
    "1\timport rule from '../../src/rules/unbound-method';",
    "2\tconst ruleTester = createRuleTesterWithTypes();",
    "> Drop `symbolsOnly` to read the source, like Read.",
  ].join("\n");
  const result = condense(output);
  if (result.includes("import rule")) {
    throw new Error("source lines must not reach the prompt");
  }
  if (result.includes("Drop `symbolsOnly`")) {
    throw new Error("the human-facing hint must not reach the prompt");
  }
  if (!result.includes("isSafeUse")) throw new Error("expected the symbols");
  if (!result.includes("used by 1 file")) {
    throw new Error("expected the dependents line");
  }
});

Deno.test("condense marks where it cut the list", () => {
  const lines = Array.from({ length: 80 }, (_, i) => `- \`s${i}\` — :${i}`);
  const result = condense(lines.join("\n"), 10);
  if (!result.includes("cut off after 10 lines")) {
    throw new Error("a silent cut would read as a complete symbol list");
  }
  same(result.split("\n").length, 11, "kept lines plus the marker");
});
