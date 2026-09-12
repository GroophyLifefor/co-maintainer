import { cloneDir, worktreeDir } from "../config.ts";
import { log } from "../util/log.ts";

/** Shared git plumbing for anything that needs a real checkout of a
 * repository — the codegraph map and the upstream/own-work scope both need
 * a clone and a way to resolve a commit that is not necessarily reachable
 * from any branch (a squash-merged or rebased-away PR head). One
 * implementation, so the two never manage the same on-disk clone in two
 * slightly different ways. */

export type CommandResult = { code: number; stdout: string; stderr: string };
export type Run = (
  command: string,
  args: string[],
  cwd?: string,
) => Promise<CommandResult>;

export async function runCommand(
  command: string,
  args: string[],
  cwd?: string,
): Promise<CommandResult> {
  // Windows resolves git and other shims through the shell, not as bare exes.
  const windows = Deno.build.os === "windows";
  const output = await new Deno.Command(windows ? "cmd" : command, {
    args: windows ? ["/c", command, ...args] : args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function cloneInto(repo: string, dir: string, run: Run): Promise<string> {
  log("checkout", `cloning ${repo} into ${dir}`);
  const started = performance.now();
  const result = await run("git", [
    "clone",
    "--filter=blob:none",
    `https://github.com/${repo}`,
    dir,
  ]);
  if (result.code !== 0) {
    throw new Error(`git clone failed: ${result.stderr.trim()}`);
  }
  // Deep source trees overrun the Windows path limit even under a short root.
  await run("git", ["config", "core.longpaths", "true"], dir);
  log(
    "checkout",
    `cloned in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  return dir;
}

/** In-flight clone per destination directory. A benchmark run reviews several
 * PRs of the same repo concurrently, and each one's scope/map computation
 * calls `ensureClone` independently; without this, the first concurrent burst
 * has every caller see "not cloned yet" and race `git clone` into the same
 * directory — one wins, the rest fail with "already exists" and silently fall
 * back to an unscoped review. Concurrent callers now await the one real clone
 * instead. The two statements between the `pathExists` check and this map's
 * `get`/`set` are synchronous (no `await` between them), so whichever caller's
 * continuation runs first registers the clone before any other caller can
 * observe an empty map entry — ordinary JS single-threaded scheduling, not a
 * lock. */
const cloningInFlight = new Map<string, Promise<string>>();

export async function ensureClone(repo: string, run: Run): Promise<string> {
  const dir = cloneDir(repo);
  if (await pathExists(`${dir}/.git`)) return dir;
  let promise = cloningInFlight.get(dir);
  if (!promise) {
    promise = cloneInto(repo, dir, run).finally(() => {
      cloningInFlight.delete(dir);
    });
    cloningInFlight.set(dir, promise);
  }
  return promise;
}

/** Resolves `candidate` to a commit SHA, or returns undefined. Two plain
 * commands rather than one `rev-parse <rev>^{commit}`: on Windows this runs
 * through `cmd /c`, where `^` is the shell's own escape character and would
 * silently eat the peel suffix, making a present commit look absent — the
 * same trap `benchmark/runners.ts`'s `requireCommit` avoids for the same
 * reason. `cat-file -t` after a caret-free `rev-parse` sidesteps it. */
async function resolveCommit(
  clone: string,
  candidate: string,
  run: Run,
): Promise<string | undefined> {
  const rev = await run(
    "git",
    ["rev-parse", "--verify", "-q", candidate],
    clone,
  );
  if (rev.code !== 0) return undefined;
  const sha = rev.stdout.trim();
  const type = await run("git", ["cat-file", "-t", sha], clone);
  if (type.code !== 0 || type.stdout.trim() !== "commit") return undefined;
  return sha;
}

/** Resolves `revision` — a branch name, a remote-tracking ref, or a commit SHA
 * — to a commit SHA, fetching it directly if it is a SHA the clone does not
 * have. A round's boundary commit is often reachable only by SHA once its
 * branch has moved on or the PR was squash-merged, so no local or
 * remote-tracking ref points at it any more. */
export async function ensureCommit(
  clone: string,
  revision: string,
  run: Run,
): Promise<string> {
  for (const candidate of [revision, `origin/${revision}`]) {
    const sha = await resolveCommit(clone, candidate, run);
    if (sha) return sha;
  }
  log("checkout", `fetching ${revision.slice(0, 10)}`);
  const fetched = await run("git", ["fetch", "origin", revision], clone);
  if (fetched.code !== 0) {
    throw new Error(`git fetch ${revision} failed: ${fetched.stderr.trim()}`);
  }
  const sha = await resolveCommit(clone, revision, run);
  if (!sha) {
    throw new Error(
      `fetched ${revision} but it still does not resolve to a commit`,
    );
  }
  return sha;
}

export async function ensureWorktree(
  repo: string,
  pr: number,
  commit: string,
  run: Run,
): Promise<string> {
  const clone = await ensureClone(repo, run);
  const sha = await ensureCommit(clone, commit, run);
  const dir = worktreeDir(repo, pr);
  if (await pathExists(`${dir}/.git`)) {
    log("checkout", `reusing worktree ${dir}`);
    const reset = await run("git", ["checkout", "-q", "--detach", sha], dir);
    if (reset.code !== 0) {
      throw new Error(`checkout ${sha} failed: ${reset.stderr.trim()}`);
    }
    return dir;
  }
  log("checkout", `creating worktree ${dir} at ${sha.slice(0, 10)}`);
  const added = await run(
    "git",
    ["worktree", "add", "-q", "--detach", dir, sha],
    clone,
  );
  if (added.code !== 0) {
    throw new Error(`git worktree add failed: ${added.stderr.trim()}`);
  }
  return dir;
}
