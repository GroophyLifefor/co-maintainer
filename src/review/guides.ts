import { reposDir } from "../config.ts";
import { getRepo } from "../store/repos.ts";
import { withKeyedLock } from "../util/keyed_lock.ts";
import { readTextFile, stat } from "../util/runtime.ts";

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

/** When the guides were generated, taken from the files themselves when this
 * process has no `repos` row (a plain local `review` never opens app.db).
 * The newest mtime wins, so rewriting any guide file counts as a rebuild. */
async function guideFilesBuiltAt(repo: string): Promise<string | null> {
  const names = [
    "PR_REVIEW_GUIDE.md",
    "PR_REVIEW_DETAILED_GUIDE.md",
    "CODEBASE.md",
    "SKILL.md",
  ];
  const times = await Promise.all(
    names.map(async (name) => {
      try {
        return (await stat(`${reposDir()}/${repo}/${name}`)).mtime;
      } catch {
        return null;
      }
    }),
  );
  const known = times
    .filter((time): time is Date => time !== null)
    .map((time) => time.getTime());
  return known.length ? new Date(Math.max(...known)).toISOString() : null;
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
    // With no `repos` row, the files are the only evidence of when the guide
    // was built. Without this a local review always says `guide unknown` and
    // can never notice that a rebuild made its carry-over stale (CORE-42).
    guideBuiltAt ??= await guideFilesBuiltAt(repo);
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
