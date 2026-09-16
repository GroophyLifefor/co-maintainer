import type { Run } from "../pr/checkout.ts";
import { normalizePath, type Revision, type RevisionFile } from "../review/revision.ts";
import {
  parseNameStatusZ,
  parseNumstatZ,
  splitDiffPatches,
} from "./git_parse.ts";
import { ReviewCliError } from "./git_ops.ts";

const diffEnv = ["-c", "core.quotePath=false"];

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
  const shallow = await run("git", ["rev-parse", "--is-shallow-repository"], cwd);
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
    const sym = await run(
      "git",
      ["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`],
      cwd,
    );
    if (sym.code === 0 && sym.stdout.trim()) {
      branch = sym.stdout.trim().split("/").pop();
    }
    if (!branch) {
      for (const candidate of ["main", "master"]) {
        const probe = await run(
          "git",
          ["rev-parse", "--verify", `refs/remotes/${remote}/${candidate}`],
          cwd,
        );
        if (probe.code === 0) {
          branch = candidate;
          break;
        }
      }
    }
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

export async function buildLocalRevision(
  cwd: string,
  mergeBaseSha: string,
  baseLabel: string,
  run: Run,
): Promise<Revision> {
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
  const unified = await run(
    "git",
    [
      ...diffEnv,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "-M",
      "--unified=3",
      base,
    ],
    cwd,
  );
  if (nameStatus.code !== 0) {
    throw new ReviewCliError("internal", "git diff failed.");
  }
  const statuses = parseNameStatusZ(nameStatus.stdout);
  const stats = parseNumstatZ(numstat.stdout);
  const patches = splitDiffPatches(unified.stdout);
  const files: RevisionFile[] = statuses.map((entry) => {
    const stat = stats.get(entry.path);
    const patch = patches.get(entry.path) ?? "";
    return {
      path: normalizePath(entry.path),
      previousPath: entry.previousPath
        ? normalizePath(entry.previousPath)
        : null,
      status: entry.status,
      binary: stat?.binary ?? false,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      patch,
    };
  });
  return {
    files,
    title: "",
    description: "",
    baseLabel,
    producer: "local",
  };
}
