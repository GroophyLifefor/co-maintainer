import { extractFacts } from "./facts.ts";
import { qualityFixtures } from "../testing/fixtures/quality.ts";
import { testOptions } from "../testing/helpers.ts";
import type { Source } from "./types.ts";
import { test } from "node:test";

test("facts remain useful for a non-Rust, non-npm fixture", () => {
  const facts = extractFacts(qualityFixtures.node, testOptions());
  if (!facts.some((item) => item.sectionKey === "layout")) {
    throw new Error("expected a module layout fact");
  }
  if (!facts.some((item) => item.claim.includes("pnpm test"))) {
    throw new Error("expected the configured package-manager command");
  }
  if (facts.some((item) => /Rust|cargo/i.test(item.claim))) {
    throw new Error("fixture received language-specific Rust guidance");
  }
  if (facts.some((item) => !item.scope || !item.confidence || !item.status)) {
    throw new Error("fact provenance metadata is missing");
  }
});

test("layout facts fire for a nested crate/package src, not just repo-root src", () => {
  // Mirrors two real layouts that produced zero deterministic layout facts
  // before the fix: a Cargo workspace (crate/src/...) and this very repo's
  // own packages/<pkg>/src/... shape.
  const source: Source = {
    repo: { full_name: "fixture/workspace", default_branch: "main" },
    tree: [
      "Cargo.toml",
      "tokio/src/runtime/builder.rs",
      "packages/eslint-plugin/src/rules/rule.ts",
    ],
    treeSha: {},
    files: {
      "tokio/src/runtime/builder.rs": "pub struct Builder {}",
      "packages/eslint-plugin/src/rules/rule.ts":
        "export function createRule() {}",
    },
    pullRequests: [],
    commits: [],
  };
  const facts = extractFacts(source, testOptions());
  const layout = facts.filter((item) => item.sectionKey === "layout");
  if (!layout.some((item) => item.claim.includes("Builder"))) {
    throw new Error("expected a layout fact for the nested Cargo crate's src/");
  }
  if (!layout.some((item) => item.claim.includes("createRule"))) {
    throw new Error("expected a layout fact for the nested package's src/");
  }
});

test("quality fixtures cover different repository shapes", () => {
  const cargoFacts = extractFacts(qualityFixtures.cargo, testOptions());
  if (!cargoFacts.some((item) => /cargo test/i.test(item.claim))) {
    throw new Error("Cargo fixture did not produce test guidance");
  }
  const docsFacts = extractFacts(qualityFixtures.docs, testOptions());
  if (!docsFacts.some((item) => item.sectionKey === "devloop")) {
    throw new Error(
      "documentation fixture did not produce development guidance",
    );
  }
});

test("frequently changed files skips paths that no longer exist", () => {
  const pullRequest = (changedFiles: string[]) => ({
    number: 1,
    title: "t",
    body: "",
    state: "closed",
    merged: true,
    updatedAt: "2026-01-01T00:00:00Z",
    headSha: "sha",
    labels: [],
    additions: 1,
    deletions: 1,
    comments: [],
    reviews: [],
    changedFiles,
    diff: "",
  });
  const source: Source = {
    repo: { full_name: "fixture/moved", default_branch: "main" },
    tree: ["src/new/app.ts"],
    treeSha: {},
    files: {},
    pullRequests: [
      pullRequest(["src/old/app.ts", "src/new/app.ts", "src/old/app.ts"]),
    ],
    commits: [],
  };
  const options = testOptions({ includePullRequestChanges: true });
  const claim = extractFacts(source, options).find((item) =>
    item.claim.startsWith("Frequently changed files"),
  )?.claim;
  if (!claim?.includes("src/new/app.ts") || claim.includes("src/old/app.ts")) {
    throw new Error(`unexpected claim: ${claim}`);
  }
  source.tree = [];
  if (
    extractFacts(source, options).some((item) =>
      item.claim.startsWith("Frequently changed files"),
    )
  ) {
    throw new Error("a claim was written with no surviving files");
  }
});
