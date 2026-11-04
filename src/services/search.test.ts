import { searchAll } from "./search.ts";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { writeUserConfig } from "../config.ts";
import { activateRepo, deactivateRepo } from "../store/repos.ts";
import { insertReview } from "../store/reviews.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { test } from "node:test";

async function withEnv(fn: () => Promise<void>): Promise<void> {
  const keys = ["CM_APP_DB", "CM_CONFIG_PATH"];
  const original = keys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    activateRepo("acme/widgets", 9);
    activateRepo("other/tools", 9);
    activateRepo("gone/repo", 9);
    deactivateRepo("gone/repo");
    for (const [id, repo, pr] of [
      ["r1", "acme/widgets", 7],
      ["r2", "acme/widgets", 7],
      ["r3", "other/tools", 12],
      ["r4", "gone/repo", 3],
    ] as const) {
      insertReview({
        id,
        repo,
        prNumber: pr,
        jobId: `job-${id}`,
        headSha: "h",
        baseSha: "b",
        scope: "full",
        model: "m",
      });
    }
    await fn();
  } finally {
    await closeAppDb();
    keys.forEach((key, i) => {
      const value = original[i];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    });
  }
}

function labels(result: ReturnType<typeof searchAll>, group: string): string[] {
  return (result.groups.find((g) => g.label === group)?.items ?? []).map(
    (item) => `${item.label} -> ${item.href}`,
  );
}

test("repositories and pull requests come from real records", async () => {
  await withEnv(async () => {
    const result = searchAll("widg");
    const repos = labels(result, "Repositories");
    if (repos.join("|") !== "acme/widgets -> /repos/acme/widgets") {
      throw new Error(`repos: ${repos.join("|")}`);
    }
    const pulls = labels(result, "Pull requests");
    // Two reviews of one PR are one result.
    if (pulls.join("|") !== "acme/widgets #7 -> /repos/acme/widgets/pulls/7") {
      throw new Error(`pulls: ${pulls.join("|")}`);
    }
  });
});

test("a PR number finds its pull request", async () => {
  await withEnv(async () => {
    const pulls = labels(searchAll("#12"), "Pull requests");
    if (pulls.join("|") !== "other/tools #12 -> /repos/other/tools/pulls/12") {
      throw new Error(pulls.join("|"));
    }
  });
});

test("pages and actions are searchable", async () => {
  await withEnv(async () => {
    const result = searchAll("usage");
    if (!labels(result, "Pages").includes("Usage -> /usage")) {
      throw new Error(JSON.stringify(result));
    }
    const actions = labels(searchAll("token"), "Actions");
    if (!actions.includes("Create a remote token -> /settings/remote")) {
      throw new Error(actions.join("|"));
    }
  });
});

test("no match returns no groups and inactive repos never show", async () => {
  await withEnv(async () => {
    const none = searchAll("zzz-nothing");
    if (none.groups.length !== 0) throw new Error(JSON.stringify(none));
    const gone = searchAll("gone");
    if (gone.groups.length !== 0) throw new Error(JSON.stringify(gone));
  });
});

test("an empty query lists pages, actions and repositories", async () => {
  await withEnv(async () => {
    const result = searchAll("");
    for (const group of ["Pages", "Repositories", "Actions"]) {
      if (!result.groups.some((g) => g.label === group && g.items.length > 0)) {
        throw new Error(`empty query lacks ${group}`);
      }
    }
  });
});
