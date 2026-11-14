/** Which CODEBASE.md sections a sync keeps from the last run.
 *
 * A sync rebuilds only the sections whose facts changed. An unchanged section
 * keeps its text, a rebuilt one takes the new text or is dropped when the
 * synthesis left it out, and a full rebuild keeps nothing old.
 */
import { test } from "node:test";
import {
  dirtySectionKeys,
  mergeCodebaseSections,
  unchangedSectionKeys,
} from "./setup.ts";
import type { State } from "../knowledge/types.ts";
import { testOptions } from "../testing/helpers.ts";

const PREVIOUS = `# Codebase conventions for acme/app

How this repository's code is actually structured and written.

## Code style

- Old style rule.

## Tests

- Old test rule.
`;

const HASHES = { style: "style-1", tests: "tests-1" };

function previousState(
  options: Partial<State["options"]> = {},
  sectionHashes: Record<string, string> = HASHES,
): State {
  const { command: _, ...rest } = testOptions({
    highModel: "high/model",
    synthesisVersion: 17,
  });
  return {
    version: 1,
    repo: "acme/app",
    options: { ...rest, ...options },
    source: {
      repo: {},
      tree: [],
      treeSha: {},
      files: {},
      pullRequests: [],
      commits: [],
    },
    facts: [],
    sectionHashes,
    scanDone: { pullRequests: 0, commits: 0, updatedAt: "" },
    updatedAt: "",
  };
}

/** What a sync writes, from the previous state and this run's fact hashes and
 * synthesized sections. `failed` are the sections whose call failed. */
function sync(
  previous: State | undefined,
  hashes: Record<string, string>,
  overrides: Record<string, string>,
  options = { highModel: "high/model", synthesisVersion: 17 },
  failed: string[] = [],
): string {
  const dirty = dirtySectionKeys(previous, options, hashes, PREVIOUS);
  return mergeCodebaseSections(
    PREVIOUS,
    overrides,
    new Set([...unchangedSectionKeys(hashes, dirty), ...failed]),
  );
}

const SAME_RUN = { highModel: "high/model", synthesisVersion: 17 };

test("a rebuilt section whose call failed keeps its old text", () => {
  const body = sync(
    previousState(),
    { style: "style-2", tests: "tests-1" },
    {},
    SAME_RUN,
    ["style"],
  );
  expect(body, ["## Code style", "- Old style rule.", "- Old test rule."], []);
});

test("a codebase section missing from CODEBASE.md is rebuilt though its facts did not change", () => {
  // `layout` has facts and the same hash as last time, but the file on disk
  // has no Code layout section, as after a 0.6.13 sync that lost it.
  const hashes = { ...HASHES, layout: "layout-1" };
  const dirty = dirtySectionKeys(
    previousState({}, hashes),
    SAME_RUN,
    hashes,
    PREVIOUS,
  );
  if (!dirty || [...dirty].join() !== "layout") {
    throw new Error(`dirty: ${JSON.stringify(dirty && [...dirty])}`);
  }
});

function expect(body: string, want: string[], unwanted: string[]): void {
  const missing = want.filter((text) => !body.includes(text));
  const present = unwanted.filter((text) => body.includes(text));
  if (missing.length || present.length) {
    throw new Error(
      `missing ${JSON.stringify(missing)} · unwanted ${JSON.stringify(present)}:\n${body}`,
    );
  }
}

test("a partial sync keeps the sections it did not rebuild", () => {
  const body = sync(
    previousState(),
    { style: "style-2", tests: "tests-1" },
    { style: "## Code style\n\n- New style rule." },
  );
  expect(body, ["## Tests", "- Old test rule."], []);
});

test("a rebuilt section replaces its old text", () => {
  const body = sync(
    previousState(),
    { style: "style-2", tests: "tests-1" },
    { style: "## Code style\n\n- New style rule." },
  );
  expect(body, ["- New style rule."], ["- Old style rule."]);
});

test("a rebuilt section that came back empty is dropped", () => {
  // The synthesis leaves a section out when the model answers with only the
  // heading, or when its only remaining facts come from pull requests.
  const body = sync(
    previousState(),
    { style: "style-2", tests: "tests-1" },
    {},
  );
  expect(body, ["- Old test rule."], ["## Code style", "- Old style rule."]);
});

test("a full rebuild keeps no old section", () => {
  const overrides = { tests: "## Tests\n\n- New test rule." };
  const cases: [string, State | undefined][] = [
    ["a new high model", previousState({ highModel: "old/model" })],
    ["a new synthesis version", previousState({ synthesisVersion: 16 })],
    ["no previous state", undefined],
  ];
  for (const [name, previous] of cases) {
    const body = sync(previous, HASHES, overrides);
    try {
      expect(
        body,
        ["- New test rule."],
        ["## Code style", "- Old style rule.", "- Old test rule."],
      );
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    }
  }
});
