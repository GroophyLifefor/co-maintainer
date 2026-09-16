import { getCacheDir } from "../config.ts";
import { ReviewCliError } from "./git_ops.ts";

async function isAlive(pid: number): Promise<boolean> {
  if (Deno.build.os === "windows") {
    const command = new Deno.Command("tasklist", {
      args: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    return new TextDecoder().decode(result.stdout).trim().startsWith('"');
  }
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    return true;
  }
}

async function lockPath(gitRoot: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(gitRoot),
  );
  const hex = [...new Uint8Array(digest)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("").slice(0, 16);
  const dir = `${getCacheDir()}/co-maintainer/locks`;
  await Deno.mkdir(dir, { recursive: true });
  return `${dir}/${hex}.lock`;
}

/** One local review per repo root (plan §13.3). */
export async function acquireLocalReviewLock(
  gitRoot: string,
): Promise<() => Promise<void>> {
  const path = await lockPath(gitRoot);
  let existingPid: number | undefined;
  try {
    existingPid = Number((await Deno.readTextFile(path)).trim());
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (
    existingPid !== undefined && Number.isInteger(existingPid) &&
    await isAlive(existingPid)
  ) {
    throw new ReviewCliError(
      "usage",
      `Another co-maintainer review is running in this repository (PID ${existingPid}).`,
    );
  }
  await Deno.writeTextFile(path, String(Deno.pid));
  return async () => {
    await Deno.remove(path).catch(() => {});
  };
}
