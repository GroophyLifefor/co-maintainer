import type { Run } from "../pr/checkout.ts";

/** `refs/remotes/<remote>/…` for scope and PR algorithms (plan §10.5). */
export async function detectDefaultBranchRef(
  cwd: string,
  remote: string,
  run: Run,
): Promise<string | undefined> {
  const symref = await run(
    "git",
    ["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`],
    cwd,
  );
  if (symref.code === 0 && symref.stdout.trim()) {
    return symref.stdout.trim();
  }
  for (const name of ["main", "master"]) {
    const ref = `refs/remotes/${remote}/${name}`;
    const probe = await run("git", ["rev-parse", "--verify", "-q", ref], cwd);
    if (probe.code === 0) return ref;
  }
  return undefined;
}

/** Short branch name (`main`) for `refs/remotes/<remote>/<branch>`. */
export async function resolveDefaultBranchName(
  cwd: string,
  remote: string,
  run: Run,
): Promise<string | undefined> {
  const ref = await detectDefaultBranchRef(cwd, remote, run);
  if (!ref) return undefined;
  const parts = ref.split("/");
  return parts[parts.length - 1];
}
