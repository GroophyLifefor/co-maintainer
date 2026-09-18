import { dirname } from "node:path";
import type { Run } from "../pr/checkout.ts";
import {
  isNotFound,
  mkdir,
  readTextFile,
  writeTextFile,
} from "../util/runtime.ts";

const EXCLUDE_LINE = "/.co-maintainer-codegraph/";

/** Plan §13.2 — hide the local codegraph index from git status. */
export async function ensureCodegraphGitExclude(
  gitRoot: string,
  run: Run,
): Promise<void> {
  const pathResult = await run(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    gitRoot,
  );
  if (pathResult.code !== 0) return;
  const excludePath = pathResult.stdout.trim();
  if (!excludePath) return;
  let text = "";
  try {
    text = await readTextFile(excludePath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const lines = text.split("\n").map((line) => line.trim());
  if (lines.includes(EXCLUDE_LINE.trim())) return;
  const prefix = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
  await mkdir(dirname(excludePath), { recursive: true }).catch(() => {});
  await writeTextFile(excludePath, `${text}${prefix}${EXCLUDE_LINE}\n`);
}
