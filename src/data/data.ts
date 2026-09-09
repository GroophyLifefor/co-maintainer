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

function withinPrWindow(updatedAt: string, months?: number): boolean {
  if (months === undefined || months === 0) return true;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return new Date(updatedAt) >= cutoff;
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
  previous?: Source,
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
  for (let index = 0; index < important.length; index++) {
    const path = important[index];
    if (
      previous?.treeSha?.[path] &&
      previous.treeSha[path] === treeSha[path] &&
      previous.files[path] !== undefined
    ) {
      files[path] = previous.files[path];
      console.log(
        `[fetch] codebase cache ${index + 1}/${important.length}: ${path}`,
      );
      if (progress) await progress({ tree, treeSha, files });
      continue;
    }
    console.log(
      `[fetch] codebase file ${index + 1}/${important.length}: ${path}`,
    );
    const content = await file(client, repo, path, branch);
    if (content !== undefined && content.length <= 200_000) {
      files[path] = content;
    }
    if (progress) await progress({ tree, treeSha, files });
  }
  return { tree, treeSha, files };
}

async function pullRequests(
  client: GitHubClient,
  options: Options,
  previous: State | undefined,
  progress?: (items: PullRequest[]) => Promise<void>,
): Promise<PullRequest[]> {
  const raw = await client.pages<Json>(
    `repos/${options.repo}/pulls?state=all&sort=updated&direction=desc`,
  );
  const selected = raw.filter((pr) =>
    withinPrWindow(String(pr.updated_at), options.maxPrMonths)
  );
  const previousByNumber = new Map(
    (previous?.source.pullRequests ?? []).map((pr) => [pr.number, pr]),
  );
  const result: PullRequest[] = [];

  for (let index = 0; index < selected.length; index++) {
    const pr = selected[index];
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
    if (!discussionUnchanged) {
      const comments = await client.pages<Json>(
        `repos/${options.repo}/issues/${number}/comments`,
      );
      const reviews = await client.pages<Json>(
        `repos/${options.repo}/pulls/${number}/reviews`,
      );
      current.comments = comments.map((comment) => String(comment.body ?? ""))
        .filter(Boolean);
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
    result.push(current);
    if (index % 10 === 0 || index === selected.length - 1) {
      console.log(`[fetch] pull requests ${index + 1}/${selected.length}`);
    }
    if (progress) await progress(result);
  }
  return result;
}

async function commits(
  client: GitHubClient,
  options: Options,
  meta: Json,
): Promise<Json[]> {
  const branch = String(meta.default_branch ?? "main");
  const limit = options.maxCommits && options.maxCommits > 0
    ? options.maxCommits
    : undefined;
  return client.pages<Json>(
    `repos/${options.repo}/commits?sha=${encodeURIComponent(branch)}`,
    limit,
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
  const repo = await client.request<Json>(`repos/${options.repo}`);
  const includeCodebase = options.includeCodebase ||
    options.includeHowRepoWorks;
  const files = includeCodebase
    ? await codebase(
      client,
      options.repo,
      repo,
      previous?.source,
      codebaseProgress,
    )
    : { tree: [], treeSha: {}, files: {} };
  const pullRequestData = options.includePullRequests
    ? await pullRequests(client, options, previous, progress)
    : [];
  const commitData = options.includeCommitHistory
    ? await commits(client, options, repo)
    : [];
  return {
    repo,
    tree: files.tree,
    treeSha: files.treeSha,
    files: files.files,
    pullRequests: pullRequestData,
    commits: commitData,
  };
}
