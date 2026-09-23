/** `GET /api/remote/guides?repo=owner/repo` — read a repository's guides with a
 * remote token (CORE-44).
 *
 * This is what `view --remote` calls. It is a read-only addition: no existing
 * route changes, and it uses the same bearer model the review endpoints use
 * (valid token, active token, lockout after repeated failures). The response
 * carries every file in the guide directory with its size and build date, so
 * the CLI prints the same headers a local `view` prints without a round trip
 * per file. */
import { reposDir } from "../../config.ts";
import { loadGuides } from "../../review/guides.ts";
import { readDir, readTextFile, stat } from "../../util/runtime.ts";
import { validateRemotePath } from "../validate.ts";

/** The four generated guides, in the order a reader wants them (CORE-23). */
const GUIDES: { kind: string; file: string }[] = [
  { kind: "skill", file: "SKILL.md" },
  { kind: "codebase", file: "CODEBASE.md" },
  { kind: "review-guide", file: "PR_REVIEW_GUIDE.md" },
  { kind: "detailed-guide", file: "PR_REVIEW_DETAILED_GUIDE.md" },
];

export type RemoteGuide = {
  kind: string;
  file: string;
  size: number;
  builtAt: string;
  content: string;
};

/** Canonicalizes `owner/repo` from the query string. A value that escapes is
 * refused before any directory is touched, the same guard the revision payload
 * uses. */
export function parseRepoQuery(
  value: string | null,
): { repo: string } | { error: string } {
  if (!value) return { error: "repo: required" };
  if (!/^[^/]+\/[^/]+$/.test(value)) {
    return { error: "repo: must be owner/repo" };
  }
  const pathErr = validateRemotePath("repo", value);
  if (pathErr) return { error: pathErr };
  return { repo: value };
}

/** Every file in `repo`'s guide directory, in `GUIDES` order first so the
 * reading order matches a local `view`, with an unexpected file (an older
 * name, a hand-written note) last. */
export async function readRemoteGuides(
  repo: string,
): Promise<{ guides: RemoteGuide[]; guideBuiltAt: string | null }> {
  const loaded = await loadGuides(repo);
  const byFile = new Map<string, string>([
    ["PR_REVIEW_GUIDE.md", loaded.shortGuide],
    ["PR_REVIEW_DETAILED_GUIDE.md", loaded.detailed],
    ["CODEBASE.md", loaded.codebase],
    ["SKILL.md", loaded.skill],
  ]);
  const dir = `${reposDir()}/${repo}`;
  const names: string[] = [];
  try {
    for await (const entry of readDir(dir)) {
      if (entry.isFile) names.push(entry.name);
    }
  } catch {
    // No directory: `loadGuides` already returned empty strings, so the caller
    // gets an empty list rather than an error.
    return { guides: [], guideBuiltAt: loaded.guideBuiltAt };
  }
  const order = (name: string): number => {
    const index = GUIDES.findIndex((guide) => guide.file === name);
    return index === -1 ? GUIDES.length : index;
  };
  const guides: RemoteGuide[] = [];
  for (const file of names.sort(
    (a, b) => order(a) - order(b) || a.localeCompare(b),
  )) {
    try {
      const info = await stat(`${dir}/${file}`);
      guides.push({
        kind: GUIDES.find((guide) => guide.file === file)?.kind ?? "other",
        file,
        size: info.size,
        builtAt: info.mtime.toISOString(),
        content: byFile.get(file) ?? (await readTextFile(`${dir}/${file}`)),
      });
    } catch {
      // The file vanished between the listing and the read: skip it rather
      // than fail the whole directory.
    }
  }
  return { guides, guideBuiltAt: loaded.guideBuiltAt };
}
