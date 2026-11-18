import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRelease,
  CHANGELOG_LINK,
  changelogSection,
  githubReleases,
  planRelease,
  type Releases,
} from "./github_release.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const CHANGELOG = [
  "# Changelog",
  "",
  "## [0.7.14] - 2026-11-18",
  "",
  "### Added",
  "",
  "- Companions in App review.",
  "",
  "## [0.7.13] - 2026-11-18",
  "",
  "### Added",
  "",
  "- `--with`.",
  "",
].join("\n");

test("a version's section is its text up to the next heading, without its own heading", () => {
  assert.equal(
    changelogSection(CHANGELOG, "0.7.14"),
    "### Added\n\n- Companions in App review.",
  );
  assert.equal(
    changelogSection(CHANGELOG, "0.7.13"),
    "### Added\n\n- `--with`.",
  );
  assert.equal(changelogSection(CHANGELOG, "0.7.1"), undefined);
});

test("every released version in the real CHANGELOG.md has a section", () => {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const version = (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version: string;
    }
  ).version.replace(/-.*$/, "");
  assert.ok(changelogSection(changelog, version), `no section for ${version}`);
});

test("a stable version without a release gets one, titled by its tag, with the section and the changelog link", () => {
  assert.deepEqual(
    planRelease({ version: "0.7.14", changelog: CHANGELOG, exists: false }),
    {
      kind: "create",
      tag: "v0.7.14",
      name: "v0.7.14",
      body: `### Added\n\n- Companions in App review.\n\n${CHANGELOG_LINK}\n`,
    },
  );
});

test("a beta and a release that exists are skipped, and a missing section fails", () => {
  assert.equal(
    planRelease({ version: "0.7.15-beta.1", changelog: "", exists: false })
      .kind,
    "skip",
  );
  assert.equal(
    planRelease({ version: "0.7.14", changelog: CHANGELOG, exists: true }).kind,
    "skip",
  );
  assert.throws(
    () =>
      planRelease({ version: "0.7.9", changelog: CHANGELOG, exists: false }),
    /no section for 0\.7\.9/,
  );
});

test("the REST layer reads a 404 as no release and posts the tag, name and body", async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith("/releases/tags/v0.7.14")) {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
      });
    }
    return new Response("{}", { status: 201 });
  }) as typeof fetch;
  const releases = githubReleases({
    repo: "owner/repo",
    token: "t",
    apiUrl: "https://api.example/",
    fetch: fake,
  });
  assert.equal(await releases.exists("v0.7.14"), false);
  await releases.create("v0.7.14", "v0.7.14", "notes");
  assert.deepEqual(calls, [
    {
      method: "GET",
      url: "https://api.example/repos/owner/repo/releases/tags/v0.7.14",
      body: undefined,
    },
    {
      method: "POST",
      url: "https://api.example/repos/owner/repo/releases",
      body: { tag_name: "v0.7.14", name: "v0.7.14", body: "notes" },
    },
  ]);
});

test("a dry run and a skip create nothing", async () => {
  let created = 0;
  const releases: Releases = {
    exists: () => Promise.resolve(false),
    create: () => {
      created++;
      return Promise.resolve();
    },
  };
  const step = planRelease({
    version: "0.7.14",
    changelog: CHANGELOG,
    exists: false,
  });
  assert.equal(
    await applyRelease(releases, step, { dryRun: true }),
    "v0.7.14: would create the release",
  );
  assert.equal(
    await applyRelease(releases, {
      kind: "skip",
      tag: "v0.7.14",
      reason: "the release already exists",
    }),
    "v0.7.14: the release already exists",
  );
  assert.equal(created, 0);
  assert.equal(await applyRelease(releases, step), "v0.7.14: release created");
  assert.equal(created, 1);
});
