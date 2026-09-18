import { reposDir } from "../config.ts";
import { getRepo } from "../store/repos.ts";
import { withKeyedLock } from "../util/keyed_lock.ts";
import { readTextFile } from "../util/runtime.ts";

export function knowledgeLockKey(repo: string): string {
  return `knowledge:${repo}`;
}

export type LoadedGuides = {
  shortGuide: string;
  detailed: string;
  codebase: string;
  skill: string;
  guideBuiltAt: string | null;
};

async function readGuideFile(repo: string, name: string): Promise<string> {
  try {
    return await readTextFile(`${reposDir()}/${repo}/${name}`);
  } catch {
    return "";
  }
}

/** Reads all review guides and `knowledge_built_at` under one lock so every
 * file belongs to the same generation. */
export async function loadGuides(repo: string): Promise<LoadedGuides> {
  return withKeyedLock(knowledgeLockKey(repo), async () => {
    const [shortGuide, detailed, codebase, skill] = await Promise.all([
      readGuideFile(repo, "PR_REVIEW_GUIDE.md"),
      readGuideFile(repo, "PR_REVIEW_DETAILED_GUIDE.md"),
      readGuideFile(repo, "CODEBASE.md"),
      readGuideFile(repo, "SKILL.md"),
    ]);
    let guideBuiltAt: string | null = null;
    try {
      guideBuiltAt = getRepo(repo)?.knowledge_built_at ?? null;
    } catch {
      // Local CLI review without `serve` — guides still load from disk.
    }
    return {
      shortGuide,
      detailed,
      codebase,
      skill,
      guideBuiltAt,
    };
  });
}

export async function withKnowledgeLock<T>(
  repo: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(knowledgeLockKey(repo), fn);
}
