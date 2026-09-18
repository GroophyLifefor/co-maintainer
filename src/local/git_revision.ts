import { resolveDefaultBranchName } from "../git/default_branch.ts";
import type { Run } from "../pr/checkout.ts";
import {
  normalizePath,
  type Revision,
  type RevisionFile,
} from "../review/revision.ts";
import {
  parseNameStatusZ,
  parseNumstatZ,
  pathsMissingPatches,
  splitDiffPatches,
} from "./git_parse.ts";
import {
  revisionFileFromUntracked,
  type UntrackedWarning,
} from "./git_untracked.ts";
import { ReviewCliError } from "./git_ops.ts";

const diffEnv = ["-c", "core.quotePath=false"];

const unifiedDiffArgs = [
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "-M",
  "--unified=3",
];

/** Single-file unified patch when bulk `git diff` did not map a path (plan §10.7). */
export async function perFileUnifiedPatch(
  cwd: string,
  base: string,
  path: string,
  run: Run,
): Promise<string> {
  const result = await run(
    "git",
    [...diffEnv, ...unifiedDiffArgs, base, "--", path],
    cwd,
  );
  if (result.code !== 0 || !result.stdout.trim()) return "";
  const map = splitDiffPatches(result.stdout);
  return map.get(path) ?? map.values().next().value ?? "";
}

export async function mergeBase(
  cwd: string,
  baseRef: string,
  remote: string,
  run: Run,
): Promise<string> {
  const result = await run(
    "git",
    [...diffEnv, "merge-base", baseRef, "HEAD"],
    cwd,
  );
  if (result.code === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  const shallow = await run(
    "git",
    ["rev-parse", "--is-shallow-repository"],
    cwd,
  );
  if (shallow.stdout.trim() === "true") {
    await run("git", ["fetch", "--quiet", "--unshallow", remote], cwd);
    const retry = await run(
      "git",
      [...diffEnv, "merge-base", baseRef, "HEAD"],
      cwd,
    );
    if (retry.code === 0 && retry.stdout.trim()) return retry.stdout.trim();
  }
  throw new ReviewCliError(
    "no_merge_base",
    "Could not find a merge base between HEAD and the target branch.",
  );
}

export async function resolveBaseRef(
  cwd: string,
  remote: string,
  toBranch: string | undefined,
  run: Run,
): Promise<{ ref: string; label: string }> {
  let branch = toBranch;
  if (!branch) {
    branch = await resolveDefaultBranchName(cwd, remote, run);
  }
  if (!branch) {
    throw new ReviewCliError(
      "base_not_found",
      "Could not determine the default branch.",
      "--to-branch=<name>",
    );
  }
  const ref = `refs/remotes/${remote}/${branch}`;
  const verify = await run("git", ["rev-parse", "--verify", ref], cwd);
  if (verify.code !== 0) {
    await run("git", ["fetch", "--quiet", remote, branch], cwd);
  }
  const again = await run("git", ["rev-parse", "--verify", ref], cwd);
  if (again.code !== 0) {
    throw new ReviewCliError(
      "base_not_found",
      `Could not resolve ${remote}/${branch}.`,
      "--to-branch=<name>",
    );
  }
  return { ref, label: `${remote}/${branch}` };
}

export type LocalRevisionBuild = {
  revision: Revision;
  warnings: UntrackedWarning[];
};

export async function buildLocalRevision(
  cwd: string,
  mergeBaseSha: string,
  baseLabel: string,
  run: Run,
): Promise<LocalRevisionBuild> {
  const base = mergeBaseSha;
  const nameStatus = await run(
    "git",
    [
      ...diffEnv,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "-M",
      "--name-status",
      "-z",
      base,
    ],
    cwd,
  );
  const numstat = await run(
    "git",
    [
      ...diffEnv,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "-M",
      "--numstat",
      "-z",
      base,
    ],
    cwd,
  );
  const unified = await run("git", [...diffEnv, ...unifiedDiffArgs, base], cwd);
  if (nameStatus.code !== 0) {
    throw new ReviewCliError("internal", "git diff failed.");
  }
  const statuses = parseNameStatusZ(nameStatus.stdout);
  const stats = parseNumstatZ(numstat.stdout);
  const patches =
    unified.code === 0
      ? splitDiffPatches(unified.stdout)
      : new Map<string, string>();
  const needsPerFile = new Set(
    unified.code !== 0
      ? statuses.filter((e) => e.status !== "removed").map((e) => e.path)
      : pathsMissingPatches(statuses, patches),
  );
  const files: RevisionFile[] = [];
  for (const entry of statuses) {
    const stat = stats.get(entry.path);
    const file: RevisionFile = {
      path: normalizePath(entry.path),
      previousPath: entry.previousPath
        ? normalizePath(entry.previousPath)
        : null,
      status: entry.status,
      binary: stat?.binary ?? false,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      patch: patches.get(entry.path) ?? "",
    };
    if (
      needsPerFile.has(entry.path) &&
      file.status !== "removed" &&
      !file.binary
    ) {
      file.patch = await perFileUnifiedPatch(cwd, base, entry.path, run);
    }
    files.push(file);
  }
  const warnings: UntrackedWarning[] = [];
  const tracked = new Set(files.map((f) => f.path));
  const untracked = await run(
    "git",
    [...diffEnv, "ls-files", "--others", "--exclude-standard", "-z"],
    cwd,
  );
  if (untracked.code === 0 && untracked.stdout) {
    for (const rel of untracked.stdout.split("\0").filter(Boolean)) {
      const path = normalizePath(rel);
      if (tracked.has(path)) continue;
      tracked.add(path);
      const result = await revisionFileFromUntracked(cwd, rel);
      if ("warning" in result) {
        warnings.push(result.warning);
        continue;
      }
      files.push(result.file);
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    revision: {
      files,
      title: "",
      description: "",
      baseLabel,
      producer: "local",
    },
    warnings,
  };
}
