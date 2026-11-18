/** Creates the GitHub Release of a published version.
 *
 *   node scripts/github_release.ts [--dry-run]
 *
 * `publish.yml` runs this after `tag_release.ts`, so the tag `v<version>`
 * exists. The release is titled `v<version>` and its notes are the version's
 * section of CHANGELOG.md, with a link to the whole changelog. A beta gets no
 * release, and a release that already exists is left alone, the same way the
 * publish step skips a version already on the registry. "Watch > Releases" on
 * GitHub notifies only on a release, never on a tag.
 *
 * Reads GITHUB_REPOSITORY and GITHUB_TOKEN (and GITHUB_API_URL on a GitHub
 * Enterprise server) from the environment, and the version from the
 * package.json in the working directory. */
import { readFileSync } from "node:fs";
import { parseVersion } from "./tag_release.ts";

/** The link under every release's notes. */
export const CHANGELOG_LINK =
  "Full changelog: https://github.com/GroophyLifefor/co-maintainer/blob/main/CHANGELOG.md";

/** The text of one version's section of CHANGELOG.md, without its heading,
 * or `undefined` when the changelog has no such section. A section starts at
 * `## [x.y.z]` and ends at the next `## ` heading. */
export function changelogSection(
  changelog: string,
  version: string,
): string | undefined {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  const text = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return text === "" ? undefined : text;
}

export type ReleaseStep =
  | { kind: "create"; tag: string; name: string; body: string }
  | { kind: "skip"; tag: string; reason: string };

/** What to do for `version`, given whether its release exists. */
export function planRelease(input: {
  version: string;
  changelog: string;
  exists: boolean;
}): ReleaseStep {
  const tag = `v${input.version}`;
  if (parseVersion(input.version).prerelease) {
    return { kind: "skip", tag, reason: "a beta gets no release" };
  }
  if (input.exists) {
    return { kind: "skip", tag, reason: "the release already exists" };
  }
  const section = changelogSection(input.changelog, input.version);
  if (section === undefined) {
    throw new Error(`CHANGELOG.md has no section for ${input.version}`);
  }
  return {
    kind: "create",
    tag,
    name: tag,
    body: `${section}\n\n${CHANGELOG_LINK}\n`,
  };
}

export type Releases = {
  exists(tag: string): Promise<boolean>;
  create(tag: string, name: string, body: string): Promise<void>;
};

/** The releases of one repository over the GitHub REST API. */
export function githubReleases(options: {
  repo: string;
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}): Releases {
  const api = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const call = options.fetch ?? fetch;
  const request = (method: string, path: string, body?: unknown) =>
    call(`${api}/repos/${options.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "co-maintainer-github-release",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function fail(method: string, path: string, response: Response) {
    let message = response.statusText;
    try {
      message = String(
        ((await response.json()) as { message?: string }).message ?? message,
      );
    } catch {
      // keep the status text
    }
    return new Error(
      `GitHub ${method} ${path} failed: ${response.status} ${message}`,
    );
  }
  return {
    async exists(tag) {
      const path = `/releases/tags/${encodeURIComponent(tag)}`;
      const response = await request("GET", path);
      if (response.status === 404) return false;
      if (!response.ok) throw await fail("GET", path, response);
      return true;
    },
    async create(tag, name, body) {
      const response = await request("POST", "/releases", {
        tag_name: tag,
        name,
        body,
      });
      if (!response.ok) throw await fail("POST", "/releases", response);
    },
  };
}

/** Does what the step says and returns one line for the log. */
export async function applyRelease(
  releases: Releases,
  step: ReleaseStep,
  options: { dryRun?: boolean } = {},
): Promise<string> {
  if (step.kind === "skip") return `${step.tag}: ${step.reason}`;
  if (options.dryRun) return `${step.tag}: would create the release`;
  await releases.create(step.tag, step.name, step.body);
  return `${step.tag}: release created`;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const version = (
    JSON.parse(readFileSync("package.json", "utf8")) as { version: string }
  ).version;
  const releases = githubReleases({
    repo: required("GITHUB_REPOSITORY"),
    token: required("GITHUB_TOKEN"),
    apiUrl: process.env.GITHUB_API_URL,
  });
  const prerelease = parseVersion(version).prerelease;
  const step = planRelease({
    version,
    changelog: readFileSync("CHANGELOG.md", "utf8"),
    exists: prerelease ? false : await releases.exists(`v${version}`),
  });
  console.log(
    await applyRelease(releases, step, {
      dryRun: process.argv.includes("--dry-run"),
    }),
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
