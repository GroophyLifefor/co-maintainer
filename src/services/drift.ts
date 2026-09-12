/** How far the repository has moved since the knowledge guide was built.
 * The numbers come from GitHub, so they are recomputed on a timer rather
 * than on every page render. */
import { getRepo } from "../store/repos.ts";
import { getDrift, upsertDrift } from "../store/drift.ts";
import { clientFor } from "./review.ts";
import { nowIso } from "../util/time.ts";
import type { DriftRow } from "../store/rows.ts";
import type { GitHubClient, Json } from "../types.ts";

const FRESH_MS = 15 * 60 * 1000;

/** GitHub caps a compare response at 300 files, so a very large drift
 * reports 300 and the UI reads "300+". */
const COMPARE_FILE_CAP = 300;

const MAX_COMMITS_COUNTED = 500;

function isCommitSha(value: string | null): value is string {
  return !!value && /^[0-9a-f]{40}$/.test(value);
}

function isFresh(row: DriftRow | undefined, nowMs: number): boolean {
  if (!row) return false;
  const at = Date.parse(row.as_of);
  return Number.isFinite(at) && nowMs - at < FRESH_MS;
}

async function searchCount(
  client: GitHubClient,
  query: string,
): Promise<number> {
  const result = await client.request<{ total_count?: number }>(
    `search/issues?per_page=1&q=${encodeURIComponent(query)}`,
  );
  return result.total_count ?? 0;
}

/** Commits and changed files in one call when we know the sha the guide was
 * built from, otherwise a date-bounded commit list with no file count. */
async function codeDrift(
  client: GitHubClient,
  repo: string,
  baseSha: string | null,
  builtAt: string,
  defaultBranch: string,
): Promise<{ commits: number; files: number }> {
  if (isCommitSha(baseSha)) {
    const compare = await client.request<
      { total_commits?: number; files?: unknown[] }
    >(
      `repos/${repo}/compare/${baseSha}...${encodeURIComponent(defaultBranch)}`,
    );
    return {
      commits: compare.total_commits ?? 0,
      files: Math.min(compare.files?.length ?? 0, COMPARE_FILE_CAP),
    };
  }
  const commits = await client.pages<Json>(
    `repos/${repo}/commits?sha=${encodeURIComponent(defaultBranch)}&since=${
      encodeURIComponent(builtAt)
    }`,
    MAX_COMMITS_COUNTED,
  );
  return { commits: commits.length, files: 0 };
}

export async function computeDrift(
  client: GitHubClient,
  repo: string,
  builtAt: string,
  baseSha: string | null,
): Promise<DriftRow> {
  const meta = await client.request<Json>(`repos/${repo}`);
  const defaultBranch = String(meta.default_branch ?? "main");
  const [opened, touched, code] = await Promise.all([
    searchCount(client, `repo:${repo} type:pr created:>${builtAt}`),
    searchCount(
      client,
      `repo:${repo} type:pr updated:>${builtAt} created:<${builtAt}`,
    ),
    codeDrift(client, repo, baseSha, builtAt, defaultBranch),
  ]);
  return {
    repo,
    as_of: nowIso(),
    prs_since: opened,
    prs_updated: touched,
    commits_since: code.commits,
    files_changed: code.files,
  };
}

/** Returns the stored row, refreshing it first when it is missing or older
 * than the freshness window. A GitHub failure keeps the previous row so a
 * dashboard page still renders. */
export async function refreshDrift(
  fullName: string,
  client?: GitHubClient,
): Promise<DriftRow | undefined> {
  const stored = getDrift(fullName);
  if (isFresh(stored, Date.now())) return stored;
  const repo = getRepo(fullName);
  if (!repo?.knowledge_built_at || repo.installation_id === null) return stored;
  try {
    const row = await computeDrift(
      client ?? clientFor(repo.installation_id),
      fullName,
      repo.knowledge_built_at,
      repo.knowledge_base_sha,
    );
    upsertDrift(row);
    return row;
  } catch {
    return stored;
  }
}
