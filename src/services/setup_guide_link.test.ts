/** A review guide a failed guide call kept stays linked from SKILL.md.
 *
 * When the AI produces no guide, `writeReviewDocuments` keeps the last run's
 * files and every review still reads them. SKILL.md must keep its link to
 * them, and `--json` says the guide was kept, not skipped.
 */
import { test } from "node:test";
import { addReviewLink, reviewGuideStatus } from "./setup.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
} from "../testing/runtime.ts";
import { mkdir, writeTextFile } from "../util/runtime.ts";

const SKILL = "# acme/app\n\n## Tests\n\n- Run the tests.\n";
const LINK = "[PR_REVIEW_GUIDE.md](PR_REVIEW_GUIDE.md)";
const DETAILED_LINK =
  "[PR_REVIEW_DETAILED_GUIDE.md](PR_REVIEW_DETAILED_GUIDE.md)";

async function withReposDir(
  files: string[],
  fn: (repo: string) => Promise<void>,
): Promise<void> {
  const original = getEnv("CM_REPOS_DIR");
  const root = tempDirSync();
  const repo = "acme/app";
  setEnv("CM_REPOS_DIR", root);
  try {
    await mkdir(`${root}/${repo}`, { recursive: true });
    for (const name of files) {
      await writeTextFile(`${root}/${repo}/${name}`, "# Guide\n\n- Check.\n");
    }
    await fn(repo);
  } finally {
    if (original === undefined) deleteEnv("CM_REPOS_DIR");
    else setEnv("CM_REPOS_DIR", original);
    await removePath(root, { recursive: true });
  }
}

test("a guide a failed guide call kept stays linked and is reported as kept", async () => {
  await withReposDir(
    ["PR_REVIEW_GUIDE.md", "PR_REVIEW_DETAILED_GUIDE.md"],
    async (repo) => {
      const status = await reviewGuideStatus(repo, undefined, 5);
      const skill = addReviewLink(SKILL, status);
      if (
        status.reviewGuide !== "kept" ||
        !skill.includes(LINK) ||
        !skill.includes(DETAILED_LINK)
      ) {
        throw new Error(`status ${JSON.stringify(status)}:\n${skill}`);
      }
    },
  );
});

test("a kept single guide is linked without the detailed guide", async () => {
  await withReposDir(["PR_REVIEW_GUIDE.md"], async (repo) => {
    const status = await reviewGuideStatus(repo, undefined, 5);
    const skill = addReviewLink(SKILL, status);
    if (
      status.reviewGuide !== "kept" ||
      !skill.includes(LINK) ||
      skill.includes(DETAILED_LINK)
    ) {
      throw new Error(`status ${JSON.stringify(status)}:\n${skill}`);
    }
  });
});

test("no guide is linked below the signal threshold or with no file on disk", async () => {
  // Below three signals `writeReviewDocuments` removes the files, so a file
  // still on disk at this point is about to go.
  await withReposDir(["PR_REVIEW_GUIDE.md"], async (repo) => {
    const status = await reviewGuideStatus(repo, undefined, 2);
    if (
      status.reviewGuide !== "skipped" ||
      addReviewLink(SKILL, status) !== SKILL
    ) {
      throw new Error(`below the threshold: ${JSON.stringify(status)}`);
    }
  });
  await withReposDir([], async (repo) => {
    const status = await reviewGuideStatus(repo, undefined, 5);
    if (
      status.reviewGuide !== "skipped" ||
      addReviewLink(SKILL, status) !== SKILL
    ) {
      throw new Error(`no file: ${JSON.stringify(status)}`);
    }
  });
});

test("a guide this run rebuilt is linked as before", async () => {
  await withReposDir([], async (repo) => {
    const single = await reviewGuideStatus(repo, { guide: "# Guide\n" }, 5);
    const detailed = await reviewGuideStatus(
      repo,
      { guide: "# Guide\n", detailed: "# Detailed\n" },
      5,
    );
    if (
      single.reviewGuide !== "single" ||
      addReviewLink(SKILL, single).includes(DETAILED_LINK) ||
      detailed.reviewGuide !== "detailed" ||
      !addReviewLink(SKILL, detailed).includes(DETAILED_LINK)
    ) {
      throw new Error(
        `single ${JSON.stringify(single)} · detailed ${JSON.stringify(detailed)}`,
      );
    }
  });
});
