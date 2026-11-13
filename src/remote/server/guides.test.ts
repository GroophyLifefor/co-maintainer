import { test } from "node:test";
import { readRemoteGuides } from "./guides.ts";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  mkdir,
  remove,
  setEnv,
  writeTextFile,
} from "../../util/runtime.ts";

test("the guides endpoint returns INSTRUCTIONS.md and RULES.json with their kinds", async () => {
  const root = await makeTempDir({ prefix: "cm-remote-guides-" });
  const previous = getEnv("CM_REPOS_DIR");
  setEnv("CM_REPOS_DIR", root);
  try {
    const dir = `${root}/acme/widgets`;
    await mkdir(dir, { recursive: true });
    await writeTextFile(`${dir}/PR_REVIEW_GUIDE.md`, "# Guide\n");
    await writeTextFile(
      `${dir}/INSTRUCTIONS.md`,
      "# Repository instructions\n",
    );
    await writeTextFile(
      `${dir}/RULES.json`,
      '{"schemaVersion":1,"builtAt":"x","rules":{}}\n',
    );
    const { guides } = await readRemoteGuides("acme/widgets");
    const kinds = guides.map((guide) => `${guide.file}=${guide.kind}`);
    if (
      kinds.join(",") !==
      "PR_REVIEW_GUIDE.md=review-guide,INSTRUCTIONS.md=instructions,RULES.json=rules"
    ) {
      throw new Error(`kinds: ${kinds.join(",")}`);
    }
    const rules = guides.find((guide) => guide.kind === "rules");
    if (!rules?.content.includes('"schemaVersion":1')) {
      throw new Error("RULES.json content is missing");
    }
  } finally {
    if (previous === undefined) deleteEnv("CM_REPOS_DIR");
    else setEnv("CM_REPOS_DIR", previous);
    await remove(root, { recursive: true });
  }
});
