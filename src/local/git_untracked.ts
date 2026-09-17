import { join } from "node:path";
import { normalizePath, type RevisionFile } from "../review/revision.ts";

const NUL_SCAN_BYTES = 8000;

export type UntrackedWarning = {
  code: "untracked_unreadable";
  message: string;
};

/** Build patch for a new untracked file (plan §10.8). */
export function patchFromNewFileContent(
  content: Uint8Array,
): { patch: string; additions: number; binary: boolean } {
  const scan = content.subarray(0, Math.min(content.length, NUL_SCAN_BYTES));
  if (scan.includes(0)) {
    return { patch: "", additions: 0, binary: true };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return { patch: "", additions: 0, binary: true };
  }
  if (text.length === 0) {
    return { patch: "", additions: 0, binary: false };
  }
  const endsWithNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (endsWithNewline && lines.at(-1) === "") lines.pop();
  const n = lines.length;
  const body = lines.map((line) => `+${line}`).join("\n");
  const header = `@@ -0,0 +1,${n} @@`;
  const patch = endsWithNewline
    ? `${header}\n${body}\n`
    : `${header}\n${body}\n\\ No newline at end of file\n`;
  return { patch, additions: n, binary: false };
}

export function patchFromSymlinkTarget(target: string): {
  patch: string;
  additions: number;
  binary: boolean;
} {
  const patch = `@@ -0,0 +1 @@\n+${target}\n`;
  return { patch, additions: 1, binary: false };
}

export async function revisionFileFromUntracked(
  cwd: string,
  relPath: string,
): Promise<{ file: RevisionFile } | { warning: UntrackedWarning }> {
  const path = normalizePath(relPath);
  const abs = join(cwd, relPath);
  try {
    const lstat = await Deno.lstat(abs);
    if (lstat.isSymlink) {
      const target = await Deno.readLink(abs);
      const { patch, additions, binary } = patchFromSymlinkTarget(target);
      return {
        file: {
          path,
          previousPath: null,
          status: "added",
          binary,
          additions,
          deletions: 0,
          patch,
        },
      };
    }
    const content = await Deno.readFile(abs);
    const { patch, additions, binary } = patchFromNewFileContent(content);
    return {
      file: {
        path,
        previousPath: null,
        status: "added",
        binary,
        additions,
        deletions: 0,
        patch,
      },
    };
  } catch {
    return {
      warning: {
        code: "untracked_unreadable",
        message: `Could not read untracked file: ${path}`,
      },
    };
  }
}
