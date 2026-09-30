/** Tags a release after it is published (CORE-132).
 *
 *   node scripts/tag_release.ts [--dry-run]
 *
 * `publish.yml` runs this once the npm package and the image are both out. It
 * creates `v<version>` on the commit that triggered the workflow and, for a
 * stable version, moves the tag for its major (`v0`) to the newest stable
 * release, so a workflow that says `@v0` follows every stable release. The
 * logic is a pure function so it can be tested without GitHub, and the GitHub
 * calls are a thin layer over REST.
 *
 * Reads GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_TOKEN (and GITHUB_API_URL on a
 * GitHub Enterprise server) from the environment, and the version from the
 * package.json in the working directory. */
import { readFileSync } from "node:fs";

export type Tag = { name: string; sha: string };

export type TagStep =
  | { kind: "create"; name: string; sha: string }
  | { kind: "move"; name: string; sha: string }
  | { kind: "skip"; name: string; reason: string };

type Parsed = {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
};

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$/;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(version: string): Parsed {
  const match = VERSION.exec(version);
  if (!match) {
    throw new Error(
      `"${version}" is not a release version like 1.2.3 or 1.2.3-beta.1`,
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  };
}

/** Numeric, so 0.10.0 is newer than 0.9.0. */
function compare(a: Parsed, b: Parsed): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** What to do for `version` released from `sha`, given the tags that exist.
 *
 * The moving tag is pointed at the newest stable release of its major, not at
 * this one, so re-running an old release never moves it backwards. */
export function planTags(input: {
  version: string;
  sha: string;
  existing: Tag[];
}): TagStep[] {
  const version = parseVersion(input.version);
  const byName = new Map(input.existing.map((tag) => [tag.name, tag.sha]));
  const versionTag = `v${input.version}`;
  const versionSha = byName.get(versionTag);
  const steps: TagStep[] = [];
  if (versionSha === undefined) {
    steps.push({ kind: "create", name: versionTag, sha: input.sha });
  } else {
    steps.push({
      kind: "skip",
      name: versionTag,
      reason:
        versionSha === input.sha
          ? "already at this commit"
          : `already exists at ${versionSha.slice(0, 7)}, left alone`,
    });
  }
  if (version.prerelease) return steps;

  const newest = { version, sha: versionSha ?? input.sha };
  for (const tag of input.existing) {
    const match = STABLE_TAG.exec(tag.name);
    if (!match) continue;
    const other: Parsed = {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      prerelease: false,
    };
    if (other.major === version.major && compare(other, newest.version) > 0) {
      newest.version = other;
      newest.sha = tag.sha;
    }
  }
  const moving = `v${version.major}`;
  const current = byName.get(moving);
  if (current === undefined) {
    steps.push({ kind: "create", name: moving, sha: newest.sha });
  } else if (current !== newest.sha) {
    steps.push({ kind: "move", name: moving, sha: newest.sha });
  } else {
    steps.push({ kind: "skip", name: moving, reason: "already current" });
  }
  return steps;
}

export type Refs = {
  list(): Promise<Tag[]>;
  create(name: string, sha: string): Promise<void>;
  move(name: string, sha: string): Promise<void>;
};

/** The tag refs of one repository over the GitHub REST API. */
export function githubRefs(options: {
  repo: string;
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}): Refs {
  const api = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const call = options.fetch ?? fetch;
  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const response = await call(`${api}/repos/${options.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "co-maintainer-tag-release",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let message = response.statusText;
      try {
        message = String(
          ((await response.json()) as { message?: string }).message ?? message,
        );
      } catch {
        // keep the status text
      }
      throw new Error(
        `GitHub ${method} ${path} failed: ${response.status} ${message}`,
      );
    }
    return response;
  }
  return {
    async list() {
      const tags: Tag[] = [];
      for (let page = 1; ; page++) {
        const response = await request(
          "GET",
          `/git/matching-refs/tags/v?per_page=100&page=${page}`,
        );
        const refs = (await response.json()) as {
          ref: string;
          object: { sha: string };
        }[];
        for (const ref of refs) {
          tags.push({
            name: ref.ref.replace(/^refs\/tags\//, ""),
            sha: ref.object.sha,
          });
        }
        if (refs.length < 100) return tags;
      }
    },
    async create(name, sha) {
      await request("POST", "/git/refs", { ref: `refs/tags/${name}`, sha });
    },
    async move(name, sha) {
      await request("PATCH", `/git/refs/tags/${name}`, { sha, force: true });
    },
  };
}

/** Does what the plan says and returns one line per step, for the log. */
export async function applyPlan(
  refs: Refs,
  steps: TagStep[],
  options: { dryRun?: boolean } = {},
): Promise<string[]> {
  const lines: string[] = [];
  for (const step of steps) {
    if (step.kind === "skip") {
      lines.push(`${step.name}: ${step.reason}`);
      continue;
    }
    const verb = step.kind === "create" ? "create" : "move";
    lines.push(
      `${step.name}: ${options.dryRun ? "would " : ""}${verb} at ${step.sha.slice(0, 7)}`,
    );
    if (options.dryRun) continue;
    if (step.kind === "create") await refs.create(step.name, step.sha);
    else await refs.move(step.name, step.sha);
  }
  return lines;
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
  const sha = required("GITHUB_SHA");
  const refs = githubRefs({
    repo: required("GITHUB_REPOSITORY"),
    token: required("GITHUB_TOKEN"),
    apiUrl: process.env.GITHUB_API_URL,
  });
  const steps = planTags({ version, sha, existing: await refs.list() });
  const lines = await applyPlan(refs, steps, {
    dryRun: process.argv.includes("--dry-run"),
  });
  for (const line of lines) console.log(line);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
