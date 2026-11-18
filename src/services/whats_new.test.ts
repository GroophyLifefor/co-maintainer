import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupedItems,
  shortItems,
  changelogSections,
  checkWhatsNew,
  CHANGELOG_URL,
  newerSections,
} from "./whats_new.ts";
import { RELEASES_URL } from "./update_check.ts";

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "- not out yet",
  "",
  "## [0.7.16] - 2026-11-20",
  "",
  "### Added",
  "",
  "- **Sixteen.** It does more.",
  "",
  "## [0.7.15] - 2026-11-18",
  "",
  "- Fifteen.",
  "",
  "## [0.7.14] - 2026-11-18",
  "",
  "- Fourteen.",
  "",
].join("\n");

test("the changelog splits into released sections, newest first, without Unreleased", () => {
  const sections = changelogSections(CHANGELOG);
  assert.deepEqual(
    sections.map((section) => [section.version, section.date]),
    [
      ["0.7.16", "2026-11-20"],
      ["0.7.15", "2026-11-18"],
      ["0.7.14", "2026-11-18"],
    ],
  );
  assert.equal(sections[0]!.body, "### Added\n\n- **Sixteen.** It does more.");
});

test("newer sections stop at the latest release and leave out what is running", () => {
  const sections = changelogSections(CHANGELOG);
  assert.deepEqual(
    newerSections(sections, "0.7.14", "0.7.15").map((s) => s.version),
    ["0.7.15"],
  );
  assert.deepEqual(
    newerSections(sections, "0.7.14", "0.7.16").map((s) => s.version),
    ["0.7.16", "0.7.15"],
  );
  assert.deepEqual(newerSections(sections, "0.7.16", "0.7.16"), []);
});

function fakeGitHub(latest: string, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === RELEASES_URL) {
      return Response.json({
        tag_name: `v${latest}`,
        html_url: `https://github.com/GroophyLifefor/co-maintainer/releases/tag/v${latest}`,
      });
    }
    if (url === CHANGELOG_URL) return new Response(CHANGELOG);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("a server behind gets the sections it has not seen, and only GitHub is asked", async () => {
  const calls: string[] = [];
  const result = await checkWhatsNew({
    fetcher: fakeGitHub("0.7.16", calls),
    running: "0.7.14",
  });
  assert.equal(result.newer, true);
  assert.equal(result.latest, "0.7.16");
  assert.deepEqual(
    result.sections.map((s) => s.version),
    ["0.7.16", "0.7.15"],
  );
  assert.deepEqual(calls.sort(), [CHANGELOG_URL, RELEASES_URL].sort());
});

test("a server on the latest version gets its own section, a beta reads as its release", async () => {
  const result = await checkWhatsNew({
    fetcher: fakeGitHub("0.7.15", []),
    running: "0.7.15-beta.2",
  });
  assert.equal(result.newer, false);
  assert.deepEqual(
    result.sections.map((s) => s.version),
    ["0.7.15"],
  );
});

test("a GitHub failure is an error, not an empty answer", async () => {
  const failing = (async () =>
    new Response("down", { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(checkWhatsNew({ fetcher: failing }), /503/);
});

test("each change becomes one short line: the bold lead, or the first sentence", () => {
  const body = [
    "### Added",
    "",
    "- **App review and PR review read companion pull requests.** `set --repo` lists them. More text.",
    "- **Output and carry-over.** The Metadata block gets a line.",
    "",
    "### Fixed",
    "",
    "- The App token for git keeps the environment's own git config. It replaced entry 0.",
  ].join("\n");
  assert.deepEqual(shortItems(body), [
    "App review and PR review read companion pull requests.",
    "Output and carry-over.",
    "The App token for git keeps the environment's own git config.",
  ]);
  assert.deepEqual(changelogSections(CHANGELOG)[0]!.items, ["Sixteen."]);
});

test("the short lines keep their Added, Changed and Fixed headings, in file order", () => {
  const body = [
    "- Before any heading.",
    "",
    "### Added",
    "",
    "- **One.** More.",
    "- **Two.** More.",
    "",
    "### Changed",
    "",
    "### Fixed",
    "",
    "- **Three.** More.",
  ].join("\n");
  assert.deepEqual(groupedItems(body), [
    { title: "Changes", items: ["Before any heading."] },
    { title: "Added", items: ["One.", "Two."] },
    { title: "Fixed", items: ["Three."] },
  ]);
});
