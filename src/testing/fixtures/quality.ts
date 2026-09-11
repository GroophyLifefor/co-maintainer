import type { Source } from "../../knowledge/types.ts";

function makeSource(
  name: string,
  tree: string[],
  files: Record<string, string>,
  extra: Partial<Source> = {},
): Source {
  return {
    repo: { full_name: `fixture/${name}`, default_branch: "main" },
    tree,
    treeSha: Object.fromEntries(tree.map((path) => [path, `sha-${path}`])),
    files,
    pullRequests: [],
    commits: [],
    ...extra,
  };
}

export const qualityFixtures: Record<string, Source> = {
  node: makeSource(
    "node-ci",
    [
      "package.json",
      "pnpm-lock.yaml",
      "src/app.ts",
      "tests/app.test.ts",
      ".github/workflows/ci.yml",
    ],
    {
      "package.json":
        '{"scripts":{"test":"vitest","check":"tsc --noEmit","build":"tsc"}}',
      "src/app.ts": "export function app() { return true; }",
      "tests/app.test.ts": "test('app', () => expect(app()).toBe(true));",
      ".github/workflows/ci.yml":
        "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm test",
    },
  ),
  cargo: makeSource(
    "cargo-release",
    ["Cargo.toml", "src/main.rs", ".github/workflows/release.yml"],
    {
      "Cargo.toml": '[package]\nname = "fixture"\nversion = "1.0.0"',
      "src/main.rs": "pub fn run() {}\nfn main() { run(); }",
      ".github/workflows/release.yml":
        "on:\n  push:\n    branches:\n      - main\njobs:\n  release:\n    steps:\n      - run: cargo build --release",
    },
  ),
  docs: makeSource(
    "docs-process",
    ["README.md", "CONTRIBUTING.md"],
    {
      "README.md":
        "# Project\n\n## Develop\nRun the documented development checks before opening a change.",
      "CONTRIBUTING.md":
        "# Contributing\n\n## Tests\nExplain the verification performed in the pull request.",
    },
  ),
};
