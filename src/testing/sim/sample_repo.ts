/** The small TypeScript repository `e2e:simulate` opens as `sim/sample`.
 *
 * Kept as strings rather than files on disk: as real `.ts` files under
 * `src/` they would be type-checked, linted and, for the tests, run by
 * `npm test` as if they were this project's own. */
export const SAMPLE_REPO_NAME = "sim/sample";

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

export const SAMPLE_REPO: Record<string, string> = {
  "README.md": lines(
    "# sample",
    "",
    "Small math and formatting helpers.",
    "",
    "## Development",
    "",
    "- `npm test` runs the tests in `test/`.",
    "- `npm run check` type-checks the project.",
  ),
  "CONTRIBUTING.md": lines(
    "# Contributing",
    "",
    "Every change to `src/` comes with a test in `test/`.",
    "Run `npm run check` and `npm test` before opening a pull request.",
  ),
  "package.json": lines(
    "{",
    '  "name": "sample",',
    '  "version": "1.0.0",',
    '  "type": "module",',
    '  "scripts": {',
    '    "check": "tsc --noEmit",',
    '    "test": "node --test test/"',
    "  },",
    '  "devDependencies": {',
    '    "typescript": "^5.6.0"',
    "  }",
    "}",
  ),
  ".github/workflows/ci.yml": lines(
    "name: CI",
    "on:",
    "  pull_request:",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: npm ci",
    "      - run: npm run check",
    "      - run: npm test",
  ),
  "src/index.ts": lines(
    'export { add, clamp } from "./math.ts";',
    'export { formatPercent } from "./format.ts";',
  ),
  "src/math.ts": lines(
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
    "export function clamp(value: number, min: number, max: number): number {",
    "  return Math.min(Math.max(value, min), max);",
    "}",
  ),
  "src/format.ts": lines(
    'import { clamp } from "./math.ts";',
    "",
    "export function formatPercent(ratio: number): string {",
    "  return `${Math.round(clamp(ratio, 0, 1) * 100)}%`;",
    "}",
  ),
  "test/math.test.ts": lines(
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add, clamp } from "../src/math.ts";',
    "",
    'test("add", () => assert.equal(add(1, 2), 3));',
    'test("clamp", () => assert.equal(clamp(5, 0, 1), 1));',
  ),
};
