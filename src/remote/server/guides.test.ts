import { test } from "node:test";
import { readRemoteGuides } from "./guides.ts";
import { mkdir, writeTextFile } from "../../util/runtime.ts";
import { withIsolatedHome } from "../../testing/isolated_home.ts";

const REPO = `acme/remote-${crypto.randomUUID()}`;

test("the guides endpoint returns INSTRUCTIONS.md and RULES.json with their kinds", async () => {
  await withIsolatedHome(async (root) => {
    const dir = `${root}/repos/${REPO}`;
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
    const { guides } = await readRemoteGuides(REPO);
    const kinds = guides.map((guide) => `${guide.file}=${guide.kind}`);
    if (
      kinds.join(",") !==
      "PR_REVIEW_GUIDE.md=review-guide,INSTRUCTIONS.md=instructions,RULES.json=rules"
    ) {
      throw new Error(`kinds: ${kinds.join(",")}`);
    }
    const rules = guides.find((guide) => guide.kind === "rules");
    if (JSON.parse(rules?.content ?? "{}").schemaVersion !== 1) {
      throw new Error(`RULES.json content is missing: ${rules?.content}`);
    }
  });
});
