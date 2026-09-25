import { runCommand, type Run } from "../pr/checkout.ts";
import { normalizeGithubRemote } from "./git_parse.ts";
import { stat } from "../util/runtime.ts";
import { CliError, EXIT_USAGE } from "../cli/error.ts";

export async function gitRoot(
  cwd: string,
  run: Run = runCommand,
): Promise<string> {
  const result = await run("git", ["rev-parse", "--show-toplevel"], cwd);
  if (result.code !== 0) {
    throw new ReviewCliError(
      "not_a_git_repo",
      "This directory is not inside a git repository.",
    );
  }
  return result.stdout.trim();
}

/** Backward-compatible name for the shared CLI error. Local and remote review
 * threw this before CORE-10 introduced `CliError`, so it stays as a thin
 * subclass and every existing call site keeps working. */
export class ReviewCliError extends CliError {
  constructor(
    code: string,
    message: string,
    hint?: string,
    exitCode = EXIT_USAGE,
  ) {
    super(code, message, hint, exitCode);
    this.name = "ReviewCliError";
  }
}

export async function assertGitQuiet(
  cwd: string,
  run: Run = runCommand,
): Promise<void> {
  const heads = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];
  for (const name of heads) {
    const path = await run("git", ["rev-parse", "--git-path", name], cwd);
    if (path.code !== 0) continue;
    try {
      await stat(path.stdout.trim());
      throw new ReviewCliError(
        "git_operation_in_progress",
        "Finish the in-progress git operation before running review.",
      );
    } catch (error) {
      if (error instanceof ReviewCliError) throw error;
    }
  }
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const path = await run("git", ["rev-parse", "--git-path", dir], cwd);
    if (path.code !== 0) continue;
    try {
      const info = await stat(path.stdout.trim());
      if (info.isDirectory()) {
        throw new ReviewCliError(
          "git_operation_in_progress",
          "Finish the in-progress rebase before running review.",
        );
      }
    } catch (error) {
      if (error instanceof ReviewCliError) throw error;
    }
  }
  const conflicts = await run(
    "git",
    ["diff", "--name-only", "--diff-filter=U"],
    cwd,
  );
  if (conflicts.stdout.trim()) {
    throw new ReviewCliError(
      "git_operation_in_progress",
      "Resolve merge conflicts before running review.",
    );
  }
}

export async function detectRemoteRepo(
  cwd: string,
  override?: string,
  run: Run = runCommand,
): Promise<string> {
  if (override) {
    if (!/^[^/]+\/[^/]+$/.test(override)) {
      throw new ReviewCliError("usage", "Repository must look like owner/repo");
    }
    return override;
  }
  const remotes = await run("git", ["remote"], cwd);
  const names = remotes.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const pick =
    ["upstream", "origin"].find((n) => names.includes(n)) ??
    (names.length === 1 ? names[0] : undefined);
  if (!pick) {
    throw new ReviewCliError(
      "repo_not_detected",
      "Could not detect the GitHub repository from remotes.",
      "--repo=owner/repo",
    );
  }
  const url = await run("git", ["remote", "get-url", pick], cwd);
  if (url.code !== 0) {
    throw new ReviewCliError(
      "repo_not_detected",
      "Could not read git remote URL.",
    );
  }
  const normalized = normalizeGithubRemote(url.stdout.trim());
  if (!normalized.ok) {
    throw new ReviewCliError(
      "unsupported_host",
      "Only github.com remotes are supported for local review.",
    );
  }
  return normalized.fullName;
}

export async function currentBranch(
  cwd: string,
  override?: string,
  run: Run = runCommand,
): Promise<string> {
  if (override) return override;
  const result = await run(
    "git",
    ["symbolic-ref", "--short", "-q", "HEAD"],
    cwd,
  );
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new ReviewCliError(
      "detached_head",
      "Detached HEAD; pass --branch=<name> to review.",
    );
  }
  return result.stdout.trim();
}

export async function headSha(
  cwd: string,
  run: Run = runCommand,
): Promise<string> {
  const result = await run("git", ["rev-parse", "HEAD"], cwd);
  if (result.code !== 0)
    throw new ReviewCliError("internal", "Could not read HEAD.");
  return result.stdout.trim();
}
