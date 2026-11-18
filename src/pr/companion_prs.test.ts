import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubHttpError } from "../github/client.ts";
import type { GitHubClient, Json } from "../types.ts";
import {
  companionLines,
  parseCompanionsSetting,
  prCompanionSearch,
  prCompanionsJson,
  readPrCompanions,
} from "./companion_prs.ts";
import {
  companionsLine,
  companionsMetadataLine,
} from "../review/companions.ts";

const LISTED = ["owner/docs", "owner/vscode-ext"];

test("the companions setting takes up to 5 owner/repo names, never the repository itself", () => {
  assert.deepEqual(
    parseCompanionsSetting(" owner/docs, owner/vscode-ext ", "owner/app"),
    ["owner/docs", "owner/vscode-ext"],
  );
  assert.equal(parseCompanionsSetting("  ", "owner/app"), undefined);
  const refused = (raw: string) => {
    try {
      parseCompanionsSetting(raw, "owner/app");
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };
  assert.equal(refused("docs"), "--companions: docs is not owner/repo");
  assert.equal(
    refused("owner/docs,"),
    "--companions: an empty name is not owner/repo",
  );
  assert.equal(
    refused("Owner/App"),
    "--companions: Owner/App is the repository itself",
  );
  assert.equal(
    refused("owner/docs,OWNER/docs"),
    "--companions: OWNER/docs is given more than once",
  );
  assert.equal(
    refused("a/1,a/2,a/3,a/4,a/5,a/6"),
    "--companions: at most 5 repositories",
  );
});

test("Companion lines count anywhere in the body, one per line, for listed repositories only", () => {
  const body = [
    "Adds the session API.",
    "",
    "companion: Owner/VSCode-Ext#45\r",
    "  COMPANION :owner/docs#112  ",
    "Companion: owner/secret#1",
    "Companion: owner/docs#113",
    "See Companion: owner/docs#7 for more.",
    "Companion: owner/docs#0",
  ].join("\n");
  assert.deepEqual(companionLines(body, LISTED), [
    { repo: "owner/vscode-ext", pr: 45 },
    { repo: "owner/docs", pr: 112 },
  ]);
  assert.deepEqual(companionLines(body, []), []);
});

type Pull = {
  number: number;
  state: string;
  merged?: boolean;
  ref: string;
  files: Json[];
};

/** GitHub for the companion repositories. Repositories missing from
 * `pulls` answer 404. Every call is kept. */
class CompanionGithub implements GitHubClient {
  calls: string[] = [];
  readonly pulls: Record<string, Pull[]>;
  readonly visibility: Record<string, boolean>;
  constructor(
    pulls: Record<string, Pull[]>,
    visibility: Record<string, boolean> = {},
  ) {
    this.pulls = pulls;
    this.visibility = visibility;
  }

  request<T>(endpoint: string): Promise<T> {
    this.calls.push(endpoint);
    const [, repo, rest] =
      /^repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(endpoint.split("?")[0]!) ?? [];
    const pulls = this.pulls[repo ?? ""];
    if (rest === undefined && repo) {
      if (repo in this.visibility) {
        return Promise.resolve({ private: this.visibility[repo] } as T);
      }
      return Promise.reject(new GitHubHttpError(404, "Not Found"));
    }
    if (!pulls) return Promise.reject(new GitHubHttpError(404, "Not Found"));
    if (rest === "/pulls") {
      return Promise.resolve(
        pulls
          .filter((pull) => pull.state === "open")
          .map((pull) => this.json(pull)) as T,
      );
    }
    const number = Number(/^\/pulls\/(\d+)$/.exec(rest ?? "")?.[1]);
    const pull = pulls.find((item) => item.number === number);
    if (!pull) return Promise.reject(new GitHubHttpError(404, "Not Found"));
    return Promise.resolve(this.json(pull) as T);
  }

  pages<T>(endpoint: string): Promise<T[]> {
    this.calls.push(endpoint);
    const [, repo, number] =
      /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/.exec(endpoint) ?? [];
    const pull = this.pulls[repo ?? ""]?.find(
      (item) => item.number === Number(number),
    );
    return pull
      ? Promise.resolve(pull.files as T[])
      : Promise.reject(new GitHubHttpError(404, "Not Found"));
  }

  private json(pull: Pull): Json {
    return {
      number: pull.number,
      state: pull.state,
      merged: pull.merged ?? false,
      head: { ref: pull.ref, sha: `sha-${pull.number}` },
    };
  }
}

const FILE = {
  filename: "src/client/session.ts",
  status: "modified",
  additions: 12,
  deletions: 4,
  patch: "@@ -1 +1 @@\n-a\n+b",
};

const reviewedPr = (body: string, ref = "feature/session-api"): Json => ({
  number: 7,
  body,
  head: { ref, sha: "head" },
});

test("a body line wins over the branch name, and a listed repository without one is looked up by branch", async () => {
  const github = new CompanionGithub(
    {
      "owner/vscode-ext": [
        { number: 45, state: "open", ref: "other-branch", files: [FILE] },
        { number: 46, state: "open", ref: "feature/session-api", files: [] },
      ],
      "owner/docs": [],
    },
    { "owner/app": false, "owner/vscode-ext": false, "owner/docs": true },
  );
  const read = await readPrCompanions({
    repo: "owner/app",
    pr: reviewedPr("Companion: owner/vscode-ext#45"),
    listed: ["owner/docs", "owner/vscode-ext"],
    reviewed: github,
    clientFor: () => Promise.resolve(github),
  });
  assert.deepEqual(prCompanionsJson(read.companions), [
    {
      repo: "owner/vscode-ext",
      branch: "other-branch",
      source: "pr-body",
      pr: 45,
      files: 1,
      status: "read",
    },
    {
      repo: "owner/docs",
      branch: "feature/session-api",
      source: "branch-name",
      pr: null,
      files: 0,
      status: "empty",
    },
  ]);
  assert.deepEqual(read.warnings, []);
  // The public companion of a public repository can be quoted, the private
  // one cannot.
  assert.deepEqual(
    read.companions.map((companion) => companion.private),
    [false, true],
  );
  assert.equal(
    companionsMetadataLine(prCompanionsJson(read.companions)),
    "- Companions: owner/vscode-ext#45, owner/docs (no matching pull request)\n",
  );
  assert.ok(
    github.calls.includes(
      "repos/owner/docs/pulls?state=open&head=owner%3Afeature%2Fsession-api&per_page=100",
    ),
  );
});

test("the branch name lookup finds an open pull request and reads its files", async () => {
  const github = new CompanionGithub({
    "owner/docs": [
      { number: 9, state: "closed", ref: "feature/session-api", files: [] },
      { number: 12, state: "open", ref: "feature/session-api", files: [FILE] },
    ],
  });
  const read = await readPrCompanions({
    repo: "owner/app",
    pr: reviewedPr("No companion lines."),
    listed: ["owner/docs"],
    reviewed: github,
    clientFor: () => Promise.resolve(github),
  });
  const [docs] = read.companions;
  assert.equal(docs?.source, "branch-name");
  assert.equal(docs?.pr, 12);
  assert.deepEqual(docs?.head, { pr: 12, sha: "sha-12" });
  assert.equal(docs?.files[0]?.path, "src/client/session.ts");
  // Visibility that cannot be read counts as private.
  assert.equal(docs?.private, true);
});

test("a merged companion pull request is read with its final diff", async () => {
  const github = new CompanionGithub({
    "owner/docs": [
      {
        number: 3,
        state: "closed",
        merged: true,
        ref: "feature/session-api",
        files: [FILE],
      },
    ],
  });
  const read = await readPrCompanions({
    repo: "owner/app",
    pr: reviewedPr("Companion: owner/docs#3"),
    listed: ["owner/docs"],
    reviewed: github,
    clientFor: () => Promise.resolve(github),
  });
  assert.equal(read.companions[0]?.status, "read");
  assert.equal(read.companions[0]?.files.length, 1);
});

test("a companion that cannot be read is unreachable, warns, and names itself", async () => {
  const github = new CompanionGithub({ "owner/docs": [] });
  const logs: string[] = [];
  const read = await readPrCompanions({
    repo: "owner/app",
    pr: reviewedPr("Companion: owner/vscode-ext#45\nCompanion: owner/docs#4"),
    listed: LISTED,
    reviewed: github,
    clientFor: (repo) =>
      Promise.resolve(repo === "owner/vscode-ext" ? undefined : github),
    log: (message) => logs.push(message),
  });
  assert.deepEqual(
    read.companions.map((companion) => [companion.repo, companion.status]),
    [
      ["owner/vscode-ext", "unreachable"],
      ["owner/docs", "unreachable"],
    ],
  );
  assert.deepEqual(
    read.warnings.map((warning) => warning.code),
    ["companion_unreachable", "companion_unreachable"],
  );
  assert.equal(
    read.warnings[0]?.message,
    "The companion owner/vscode-ext#45 could not be read, so the review ran without it.",
  );
  assert.equal(
    companionsMetadataLine(prCompanionsJson(read.companions)),
    "- Companions: owner/vscode-ext#45 (unreachable), owner/docs#4 (unreachable)\n",
  );
  assert.equal(
    companionsLine(prCompanionsJson(read.companions)),
    "Companions: owner/vscode-ext#45 (unreachable) · owner/docs#4 (unreachable)",
  );
  assert.ok(logs.some((line) => line.includes("owner/docs#4")));
});

test("without the setting, or with every listed repository given by --with, nothing is read", async () => {
  const github = new CompanionGithub({});
  for (const input of [
    { listed: [], skip: [] },
    { listed: ["owner/docs"], skip: ["Owner/Docs"] },
  ]) {
    const read = await readPrCompanions({
      repo: "owner/app",
      pr: reviewedPr("Companion: owner/docs#4"),
      reviewed: github,
      clientFor: () => Promise.resolve(github),
      ...input,
    });
    assert.deepEqual(read, { companions: [], warnings: [] });
  }
  assert.deepEqual(github.calls, []);
});

test("search of a companion without a pull request says there is nothing to check out", async () => {
  const search = prCompanionSearch([
    {
      repo: "owner/docs",
      branch: "feature/session-api",
      files: [],
      private: false,
      source: "branch-name",
      pr: null,
      status: "empty",
    },
  ]);
  assert.equal(
    await search("owner/docs", { pattern: "startSession" }),
    "Tool error: owner/docs has no pull request for this branch, so there is no checkout of it to search",
  );
});
