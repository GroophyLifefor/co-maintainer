import { ensureClone, ensureCommit, type Run, runCommand } from "./checkout.ts";
import { log } from "../util/log.ts";

/** What a pull request's author actually wrote this round, as opposed to code
 * that arrived by merging the default branch in. A re-review round's diff
 * regularly includes a `merge main` a human reviewer never reads and a bot
 * should not either — one measured case in this repo's own benchmark had a
 * round diff of 48 files where the author's own commits touched 5. Findings
 * belong in the own set; upstream code is context, shown but not policed,
 * because the author's own change can still interact badly with it. */

export type ScopeResult = {
  /** Files touched by a commit the author made this round: their own
   * non-merge commits, plus the conflict-resolution hunks of any merge they
   * made. A clean "merge main in" contributes nothing here — `--cc` only
   * surfaces lines that differ from every parent, which is exactly the part
   * a human resolved by hand. */
  ownFiles: Set<string>;
  /** Everything else touched between the round's boundary and its head —
   * code that arrived via a merge and was not authored this round. */
  upstreamFiles: Set<string>;
  defaultBranch: string;
  ownCommits: number;
  mergeCommits: number;
};

function lines(output: string): string[] {
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function detectDefaultBranch(
  clone: string,
  run: Run,
): Promise<string | undefined> {
  const symref = await run(
    "git",
    ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
    clone,
  );
  if (symref.code === 0 && symref.stdout.trim()) return symref.stdout.trim();
  // A clone made without `origin/HEAD` set up (rare, but seen with some
  // mirroring tools) falls back to probing the two conventional names.
  for (const name of ["main", "master"]) {
    const probe = await run(
      "git",
      ["rev-parse", "--verify", "-q", `refs/remotes/origin/${name}`],
      clone,
    );
    if (probe.code === 0) return `refs/remotes/origin/${name}`;
  }
  return undefined;
}

/** The scope algorithm against a clone that is already on disk. Split out from
 * `computeScope` so a caller that already manages its own clone — the
 * benchmark's OCR runner has its own, separate from co-maintainer's — can run
 * the identical algorithm without a second clone of the same repository. */
export async function scopeInClone(
  clone: string,
  base: string,
  head: string,
  run: Run = runCommand,
): Promise<ScopeResult | undefined> {
  let baseSha: string;
  let headSha: string;
  try {
    baseSha = await ensureCommit(clone, base, run);
    headSha = await ensureCommit(clone, head, run);
  } catch (error) {
    log("scope", `unavailable · ${String(error)}`);
    return undefined;
  }
  const defaultBranch = await detectDefaultBranch(clone, run);
  if (!defaultBranch) {
    log("scope", "unavailable · could not determine the default branch");
    return undefined;
  }

  // Mirrors GitHub's three-dot compare: the round started at the point where
  // the PR's branch diverged, not at whatever `base` happens to be today.
  const mergeBase = await run("git", ["merge-base", baseSha, headSha], clone);
  const boundary = mergeBase.code === 0 ? mergeBase.stdout.trim() : baseSha;
  const range = [`${boundary}..${headSha}`, "--not", defaultBranch];

  const [ownCommits, mergeCommits, allFiles] = await Promise.all([
    run("git", ["rev-list", "--no-merges", ...range], clone),
    run("git", ["rev-list", "--merges", ...range], clone),
    run("git", ["diff", "--name-only", `${boundary}..${headSha}`], clone),
  ]);
  if (ownCommits.code !== 0 || mergeCommits.code !== 0 || allFiles.code !== 0) {
    log("scope", "unavailable · git failed to list the round's commits");
    return undefined;
  }

  const ownFiles = new Set<string>();
  for (const sha of lines(ownCommits.stdout)) {
    const shown = await run(
      "git",
      ["show", "--name-only", "--format=", sha],
      clone,
    );
    for (const path of lines(shown.stdout)) ownFiles.add(path);
  }
  for (const sha of lines(mergeCommits.stdout)) {
    const resolved = await run(
      "git",
      ["diff-tree", "--cc", "-r", "--no-commit-id", "--name-only", sha],
      clone,
    );
    for (const path of lines(resolved.stdout)) ownFiles.add(path);
  }

  const upstreamFiles = new Set(
    lines(allFiles.stdout).filter((path) => !ownFiles.has(path)),
  );
  log(
    "scope",
    `${ownFiles.size} own files · ${upstreamFiles.size} upstream files · ` +
      `${lines(ownCommits.stdout).length} commits · ${
        lines(mergeCommits.stdout).length
      } merges · default=${defaultBranch}`,
  );
  return {
    ownFiles,
    upstreamFiles,
    defaultBranch,
    ownCommits: lines(ownCommits.stdout).length,
    mergeCommits: lines(mergeCommits.stdout).length,
  };
}

/** Clones (or reuses) `repo` under co-maintainer's own cache and runs the
 * scope algorithm against it. Returns `undefined` on any failure — no clone,
 * an unresolvable commit, no default branch to compare against — so the
 * caller's fallback is always "review everything, unscoped", never a broken
 * review. */
export async function computeScope(
  repo: string,
  base: string,
  head: string,
  options: { run?: Run } = {},
): Promise<ScopeResult | undefined> {
  const run = options.run ?? runCommand;
  let clone: string;
  try {
    clone = await ensureClone(repo, run);
  } catch (error) {
    log("scope", `unavailable · ${String(error)}`);
    return undefined;
  }
  return await scopeInClone(clone, base, head, run);
}
