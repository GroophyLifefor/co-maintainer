import { startHeartbeat } from "../log.ts";
import { cacheGet, cacheSet } from "../state/database.ts";
import type {
  GitHubClient,
  Json,
  Options,
  PullRequest,
  Source,
  State,
} from "../types.ts";

function decodeBase64(value: string): string {
  const binary = atob(value.replaceAll("\n", ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

type FetchPhase = { text: string };

function percent(done: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((done / total) * 100)}%`;
}

function withinPrWindow(updatedAt: string, months?: number): boolean {
  if (months === undefined || months === 0) return true;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return new Date(updatedAt) >= cutoff;
}

function listingCovers(cachedMonths: number, current?: number): boolean {
  if (cachedMonths === 0) return true;
  if (current === undefined || current === 0) return false;
  return cachedMonths >= current;
}

type CachedListing = { maxPrMonths: number; items: Json[] };

async function loadListing(repo: string): Promise<CachedListing | undefined> {
  const raw = await cacheGet("pr-listing", repo);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as CachedListing;
  if (!Array.isArray(parsed.items)) return undefined;
  return parsed;
}

async function saveListing(
  repo: string,
  maxPrMonths: number | undefined,
  items: Json[],
): Promise<void> {
  await cacheSet(
    "pr-listing",
    repo,
    JSON.stringify({ maxPrMonths: maxPrMonths ?? 0, items }),
  );
}

async function listPullRequestPages(
  client: GitHubClient,
  options: Options,
  phase?: FetchPhase,
): Promise<Json[]> {
  const cached = await loadListing(options.repo);
  const canCatchUp = cached !== undefined &&
    listingCovers(cached.maxPrMonths, options.maxPrMonths);
  const cachedByNumber = new Map(
    (cached?.items ?? []).map((pr) => [Number(pr.number), pr]),
  );
  const selected: Json[] = [];
  const seen = new Set<number>();
  const concurrency = Math.max(1, options.ghConcurrent);
  console.log(
    `[fetch] pull request listing · concurrency=${concurrency}`,
  );

  const fetchPage = async (page: number): Promise<Json[]> => {
    const pageItems = await client.request<Json[]>(
      `repos/${options.repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
    );
    return Array.isArray(pageItems) ? pageItems : [];
  };

  const ingest = (page: number, pageItems: Json[]): boolean => {
    if (pageItems.length === 0) {
      const message =
        `pull request listing · page ${page} · fetched ${selected.length} · done`;
      if (phase) phase.text = message;
      console.log(`[fetch] ${message}`);
      return true;
    }
    let stop = false;
    let reason = "total unknown";
    for (const pr of pageItems) {
      const updatedAt = String(pr.updated_at ?? "");
      if (!withinPrWindow(updatedAt, options.maxPrMonths)) {
        stop = true;
        reason = "window reached";
        break;
      }
      const number = Number(pr.number);
      selected.push(pr);
      seen.add(number);
      const prior = cachedByNumber.get(number);
      if (canCatchUp && String(prior?.updated_at ?? "") === updatedAt) {
        stop = true;
        reason = "cache catch-up";
        break;
      }
    }
    const message =
      `pull request listing · page ${page} · fetched ${selected.length} · ${reason}`;
    if (phase) phase.text = message;
    console.log(`[fetch] ${message}`);
    return stop || pageItems.length < 100;
  };

  const first = await fetchPage(1);
  let done = ingest(1, first);
  let page = 2;
  while (!done) {
    const batch = Array.from(
      { length: concurrency },
      (_, index) => page + index,
    );
    const pages = await mapPool(batch, concurrency, (item) => fetchPage(item));
    for (let index = 0; index < pages.length; index++) {
      if (ingest(batch[index], pages[index])) {
        done = true;
        break;
      }
    }
    page += concurrency;
  }

  if (canCatchUp) {
    let reused = 0;
    for (const pr of cached?.items ?? []) {
      const number = Number(pr.number);
      if (seen.has(number)) continue;
      if (!withinPrWindow(String(pr.updated_at ?? ""), options.maxPrMonths)) {
        continue;
      }
      selected.push(pr);
      seen.add(number);
      reused++;
    }
    if (reused > 0) {
      console.log(
        `[fetch] pull request listing · reused ${reused} cached PRs · ${selected.length} total`,
      );
    }
  }

  await saveListing(options.repo, options.maxPrMonths, selected);
  return selected;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      worker,
    ),
  );
  return results;
}

async function file(
  client: GitHubClient,
  repo: string,
  path: string,
  branch: string,
): Promise<string | undefined> {
  try {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const result = await client.request<Json>(
      `repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    );
    if (typeof result.content !== "string") return undefined;
    return decodeBase64(result.content);
  } catch {
    return undefined;
  }
}

async function codebase(
  client: GitHubClient,
  repo: string,
  meta: Json,
  concurrency: number,
  previous?: Source,
  phase?: FetchPhase,
  progress?: (data: {
    tree: string[];
    treeSha: Record<string, string>;
    files: Record<string, string>;
  }) => Promise<void>,
): Promise<
  {
    tree: string[];
    treeSha: Record<string, string>;
    files: Record<string, string>;
  }
> {
  const branch = String(meta.default_branch ?? "main");
  const response = await client.request<Json>(
    `repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  const blobs = Array.isArray(response.tree)
    ? response.tree.filter((item) => (item as Json).type === "blob")
    : [];
  const tree = blobs.map((item) => String((item as Json).path));
  const treeSha = Object.fromEntries(
    blobs.map((item) => {
      const value = item as Json;
      return [String(value.path), String(value.sha ?? "")];
    }),
  );
  const canonical = tree.filter((path) =>
    /(^|\/)(README|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|CHANGELOG)(\.[^/]*)?$|(^|\/)(package\.json|deno\.json|Cargo\.toml|Makefile|justfile|CODEOWNERS|build\.rs)$|^\.github\/(workflows\/.+\.(yml|yaml)|PULL_REQUEST_TEMPLATE.*)$/i
      .test(
        path,
      )
  );
  const representative = tree.filter((path) =>
    /\.(rs|ts|tsx|js|jsx|py|go|java|cs|cpp|c|swift)$/i.test(path) &&
    !/(^|\/)(test|tests|vendor|dist|target)\//i.test(path)
  ).slice(0, 20);
  const important = [...new Set([...canonical, ...representative])].slice(
    0,
    80,
  );
  const files: Record<string, string> = {};
  let completed = 0;
  let save = Promise.resolve();
  if (phase) {
    phase.text =
      `codebase files 0/${important.length} · 0% · concurrency=${concurrency}`;
  }
  console.log(
    `[fetch] codebase · ${important.length} files · concurrency=${concurrency}`,
  );
  const checkpoint = () => {
    if (!progress) return Promise.resolve();
    save = save.then(() => progress({ tree, treeSha, files: { ...files } }));
    return save;
  };
  await mapPool(important, concurrency, async (path) => {
    if (
      previous?.treeSha?.[path] &&
      previous.treeSha[path] === treeSha[path] &&
      previous.files[path] !== undefined
    ) {
      files[path] = previous.files[path];
      completed++;
      if (phase) {
        phase.text = `codebase files ${completed}/${important.length} · ${
          percent(completed, important.length)
        }`;
      }
      console.log(
        `[fetch] codebase cache ${completed}/${important.length} · ${
          percent(completed, important.length)
        }: ${path}`,
      );
      await checkpoint();
      return;
    }
    const content = await file(client, repo, path, branch);
    if (content !== undefined && content.length <= 200_000) {
      files[path] = content;
    }
    completed++;
    if (phase) {
      phase.text = `codebase files ${completed}/${important.length} · ${
        percent(completed, important.length)
      }`;
    }
    console.log(
      `[fetch] codebase file ${completed}/${important.length} · ${
        percent(completed, important.length)
      }: ${path}`,
    );
    await checkpoint();
  });
  return { tree, treeSha, files };
}

async function pullRequests(
  client: GitHubClient,
  options: Options,
  previous: State | undefined,
  phase?: FetchPhase,
  progress?: (items: PullRequest[]) => Promise<void>,
): Promise<PullRequest[]> {
  if (phase) phase.text = "listing pull requests · page 0 · fetched 0";
  const selected = await listPullRequestPages(client, options, phase);
  const previousByNumber = new Map(
    (previous?.source.pullRequests ?? []).map((pr) => [pr.number, pr]),
  );
  const result: PullRequest[] = new Array(selected.length);
  let completed = 0;
  let save = Promise.resolve();
  if (phase) {
    phase.text =
      `pull requests 0/${selected.length} · 0% · concurrency=${options.ghConcurrent}`;
  }
  console.log(
    `[fetch] ${selected.length} pull requests · concurrency=${options.ghConcurrent}`,
  );

  await mapPool(selected, options.ghConcurrent, async (pr, index) => {
    const number = Number(pr.number);
    const cached = previousByNumber.get(number);
    const listedAdditions = Number(pr.additions);
    const listedDeletions = Number(pr.deletions);
    const listedStatsAvailable = Number.isFinite(listedAdditions) &&
      Number.isFinite(listedDeletions) &&
      pr.additions !== undefined &&
      pr.deletions !== undefined;
    const cachedStatsAvailable = cached &&
      cached.updatedAt === String(pr.updated_at ?? "") &&
      cached.headSha === String((pr.head as Json | undefined)?.sha ?? "") &&
      Number.isFinite(cached.additions) &&
      Number.isFinite(cached.deletions);
    let detail: Json | undefined = listedStatsAvailable
      ? pr
      : cachedStatsAvailable
      ? {
        additions: cached.additions,
        deletions: cached.deletions,
      }
      : undefined;
    if (!detail) {
      try {
        detail = await client.request<Json>(
          `repos/${options.repo}/pulls/${number}`,
        );
      } catch (error) {
        console.log(
          `[fetch] PR #${number} detail unavailable; diff skipped: ${
            String(error)
          }`,
        );
      }
    }
    const current: PullRequest = {
      number,
      title: String(pr.title ?? ""),
      body: String(pr.body ?? ""),
      state: String(pr.state ?? ""),
      merged: Boolean(pr.merged_at),
      updatedAt: String(pr.updated_at ?? ""),
      headSha: String((pr.head as Json | undefined)?.sha ?? ""),
      labels: Array.isArray(pr.labels)
        ? pr.labels.map((label) => String((label as Json).name))
        : [],
      additions: Number(detail?.additions ?? cached?.additions ?? 0),
      deletions: Number(detail?.deletions ?? cached?.deletions ?? 0),
      comments: cached?.comments ?? [],
      reviews: cached?.reviews ?? [],
      changedFiles: cached?.changedFiles ?? [],
      diff: cached?.diff ?? "",
    };
    const discussionUnchanged = cached?.updatedAt === current.updatedAt;
    const diffUnchanged = cached?.headSha === current.headSha &&
      Boolean(cached?.diff);
    const discussionStatus = discussionUnchanged
      ? "comments/reviews cache"
      : "download comments/reviews";
    let diffStatus = "diff disabled";
    if (options.includePullRequestChanges) {
      const lines = current.additions + current.deletions;
      diffStatus = diffUnchanged
        ? "diff cache"
        : !detail
        ? "diff unavailable"
        : options.maxPullRequestChangeLines !== undefined &&
            lines > options.maxPullRequestChangeLines
        ? `diff skipped (${lines} lines > limit)`
        : "download diff";
    }
    if (phase) {
      phase.text =
        `PR #${number} · ${discussionStatus} · ${diffStatus} · ${completed}/${selected.length} · ${
          percent(completed, selected.length)
        }`;
    }
    if (!discussionUnchanged) {
      const comments = await client.pages<Json>(
        `repos/${options.repo}/issues/${number}/comments`,
      );
      const reviews = await client.pages<Json>(
        `repos/${options.repo}/pulls/${number}/reviews`,
      );
      current.comments = comments.map((comment) => String(comment.body ?? ""))
        .filter(Boolean)
        .slice(0, options.maxComments);
      current.reviews = reviews.map((review) => String(review.body ?? ""))
        .filter(Boolean);
    }
    if (options.includePullRequestChanges && !diffUnchanged && detail) {
      const lines = current.additions + current.deletions;
      if (
        options.maxPullRequestChangeLines === undefined ||
        lines <= options.maxPullRequestChangeLines
      ) {
        const files = await client.pages<Json>(
          `repos/${options.repo}/pulls/${number}/files`,
        );
        current.changedFiles = files.map((item) => String(item.filename))
          .filter(Boolean);
        current.diff = files.map((item) => {
          const path = String(item.filename ?? "");
          const patch = String(item.patch ?? "");
          return patch ? `FILE: ${path}\n${patch}` : "";
        }).filter(Boolean).join("\n\n");
      } else {
        current.changedFiles = [];
        current.diff = "";
      }
    }
    result[index] = current;
    completed++;
    if (phase) {
      phase.text = `pull requests ${completed}/${selected.length} · ${
        percent(completed, selected.length)
      }`;
    }
    console.log(
      `[fetch] PR ${completed}/${selected.length} · ${
        percent(completed, selected.length)
      } #${number} · ${discussionStatus} · ${diffStatus}`,
    );
    if (progress) {
      save = save.then(() =>
        progress(result.filter((item): item is PullRequest => !!item))
      );
      await save;
    }
  });
  return result;
}

async function commits(
  client: GitHubClient,
  options: Options,
  meta: Json,
  phase?: FetchPhase,
): Promise<Json[]> {
  const branch = String(meta.default_branch ?? "main");
  const limit = options.maxCommits && options.maxCommits > 0
    ? options.maxCommits
    : undefined;
  if (phase) phase.text = "commit history · page 0 · fetched 0";
  return client.pages<Json>(
    `repos/${options.repo}/commits?sha=${encodeURIComponent(branch)}`,
    limit,
    (page, fetched) => {
      const message =
        `commit history · page ${page} · fetched ${fetched} · total unknown`;
      if (phase) phase.text = message;
      console.log(`[fetch] ${message}`);
    },
  );
}

export async function collectSource(
  client: GitHubClient,
  options: Options,
  previous?: State,
  progress?: (items: PullRequest[]) => Promise<void>,
  codebaseProgress?: (data: {
    tree: string[];
    treeSha: Record<string, string>;
    files: Record<string, string>;
  }) => Promise<void>,
): Promise<Source> {
  const phase: FetchPhase = { text: "reading repository metadata" };
  const stopHeartbeat = startHeartbeat(() => phase.text);
  try {
    const repo = await client.request<Json>(`repos/${options.repo}`);
    const includeCodebase = options.includeCodebase ||
      options.includeHowRepoWorks;
    const files = includeCodebase
      ? await codebase(
        client,
        options.repo,
        repo,
        options.ghConcurrent,
        previous?.source,
        phase,
        codebaseProgress,
      )
      : { tree: [], treeSha: {}, files: {} };
    const pullRequestData = options.includePullRequests
      ? await pullRequests(client, options, previous, phase, progress)
      : [];
    const commitData = options.includeCommitHistory
      ? await commits(client, options, repo, phase)
      : [];
    return {
      repo,
      tree: files.tree,
      treeSha: files.treeSha,
      files: files.files,
      pullRequests: pullRequestData,
      commits: commitData,
    };
  } finally {
    stopHeartbeat();
  }
}
