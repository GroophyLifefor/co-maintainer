/** When a `sync` edits the review guide and when it rewrites it in full
 * (#113), and how the count of edits moves. */
import { test } from "node:test";
import { guideEditInput, guideState } from "./setup.ts";
import { writeUserConfig } from "../config.ts";
import { testOptions } from "../testing/helpers.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  removePath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { isolateTestFile } from "../testing/locations.ts";
import type { State } from "../knowledge/types.ts";
import type { ReviewDocuments } from "../knowledge/guide.ts";

isolateTestFile();

const REPO = "acme/edit";
const RULES = { R1: { file: "PR_REVIEW_GUIDE.md", text: "a", sources: [] } };

function previous(edits: number): State {
  return { guide: { findings: ["a rule"], edits } } as unknown as State;
}

async function withRepo(
  every: number | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const dir = tempDirSync();
  const saved = [getEnv("CM_CONFIG_PATH"), getEnv("CM_REPOS_DIR")];
  try {
    setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
    setEnv("CM_REPOS_DIR", `${dir}/repos`);
    await mkdirPath(`${dir}/repos/${REPO}`, { recursive: true });
    await writeTextFile(
      `${dir}/repos/${REPO}/PR_REVIEW_GUIDE.md`,
      "# G\n\n## P\n\n- a · b [R1]\n",
    );
    if (every !== undefined) {
      await writeUserConfig({ repos: { [REPO]: { guideFullEvery: every } } });
    }
    await fn();
  } finally {
    if (saved[0] === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", saved[0]);
    if (saved[1] === undefined) deleteEnv("CM_REPOS_DIR");
    else setEnv("CM_REPOS_DIR", saved[1]);
    await removePath(dir, { recursive: true });
  }
}

const sync = (extra = {}) =>
  testOptions({ command: "remake", repo: REPO, ...extra });

test("init and --full-guide rewrite in full, a sync edits", async () => {
  await withRepo(undefined, async () => {
    if (
      await guideEditInput(
        testOptions({ command: "init", repo: REPO }),
        previous(0),
        RULES,
      )
    ) {
      throw new Error("init edited the guide");
    }
    if (await guideEditInput(sync({ fullGuide: true }), previous(0), RULES)) {
      throw new Error("--full-guide edited the guide");
    }
    const edit = await guideEditInput(sync(), previous(0), RULES);
    if (!edit?.guide.includes("[R1]")) throw new Error("a sync did not edit");
  });
});

test("the default rewrites in full on the 10th changed sync, an unchanged one still keeps the guide", async () => {
  await withRepo(undefined, async () => {
    const ninth = await guideEditInput(sync(), previous(8), RULES);
    if (!ninth || ninth.rewriteIfChanged)
      throw new Error("the 9th sync did not edit");
    const tenth = await guideEditInput(sync(), previous(9), RULES);
    if (!tenth?.rewriteIfChanged) {
      throw new Error(
        "the 10th sync was not marked to rewrite a changed guide",
      );
    }
  });
});

test("--guide-full-every=1 always rewrites, 0 never does after init", async () => {
  await withRepo(1, async () => {
    if (await guideEditInput(sync(), previous(0), RULES)) {
      throw new Error("1 edited the guide");
    }
  });
  await withRepo(0, async () => {
    if (!(await guideEditInput(sync(), previous(500), RULES))) {
      throw new Error("0 rewrote the guide");
    }
  });
});

test("an edit counts, a kept guide does not, a full rewrite starts again", () => {
  const docs = { guide: "x" } as ReviewDocuments;
  const facts: never[] = [];
  const edits = (mode: "full" | "edit" | "unchanged", before: number) =>
    guideState(previous(before), { mode }, docs, facts).guide?.edits;
  if (edits("edit", 3) !== 4) throw new Error("an edit did not count");
  if (edits("unchanged", 3) !== 3) throw new Error("a kept guide counted");
  if (edits("full", 3) !== 0) throw new Error("a full rewrite did not reset");
});

test("a detailed guide the last build wrote and that is gone now rewrites in full", async () => {
  await withRepo(undefined, async () => {
    const detailedRules = {
      R1: { file: "PR_REVIEW_DETAILED_GUIDE.md", text: "a", sources: [] },
    };
    if (await guideEditInput(sync(), previous(0), detailedRules)) {
      throw new Error("edited the short guide alone");
    }
  });
});

test("an empty detailed guide rewrites in full", async () => {
  await withRepo(undefined, async () => {
    await writeTextFile(
      `${getEnv("CM_REPOS_DIR")}/${REPO}/PR_REVIEW_DETAILED_GUIDE.md`,
      "",
    );
    if (await guideEditInput(sync(), previous(0), RULES)) {
      throw new Error("edited with an empty detailed guide");
    }
  });
});
