/** Pure parsers for git -z output and remote URL normalization (plan §10). */

export type NameStatusEntry = {
  status: "added" | "modified" | "removed" | "renamed";
  path: string;
  previousPath?: string;
};

export type NumstatEntry = {
  additions: number;
  deletions: number;
  binary: boolean;
};

export type NormalizeRemoteResult =
  | { ok: true; fullName: string }
  | { ok: false; code: "unsupported_host" };

export function normalizeGithubRemote(url: string): NormalizeRemoteResult {
  const trimmed = url.trim().replace(/\/+$/, "");
  let host = "";
  let path = "";
  if (trimmed.startsWith("git@")) {
    const match = /^git@([^:]+):(.+)$/i.exec(trimmed);
    if (!match) return { ok: false, code: "unsupported_host" };
    host = match[1];
    path = match[2];
  } else if (trimmed.startsWith("ssh://")) {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\//, "");
    } catch {
      return { ok: false, code: "unsupported_host" };
    }
  } else if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\//, "");
    } catch {
      return { ok: false, code: "unsupported_host" };
    }
  } else {
    return { ok: false, code: "unsupported_host" };
  }
  if (host.toLowerCase() !== "github.com") {
    return { ok: false, code: "unsupported_host" };
  }
  if (path.endsWith(".git")) path = path.slice(0, -4);
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return { ok: false, code: "unsupported_host" };
  const owner = parts[0];
  const repo = parts[1];
  return { ok: true, fullName: `${owner}/${repo}` };
}

/** Parse `git diff --name-status -z` records (NUL-separated). */
export function parseNameStatusZ(raw: string): NameStatusEntry[] {
  if (!raw) return [];
  const parts = raw.split("\0").filter((p) => p.length > 0);
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    if (token.startsWith("R")) {
      const path = parts[i + 2];
      const previousPath = parts[i + 1];
      if (!path || !previousPath) break;
      entries.push({ status: "renamed", path, previousPath });
      i += 2;
      continue;
    }
    if (token === "T") {
      const path = parts[i + 1];
      if (!path) break;
      entries.push({ status: "modified", path });
      i += 1;
      continue;
    }
    const path = parts[i + 1];
    if (!path) break;
    if (token === "A") entries.push({ status: "added", path });
    else if (token === "M") entries.push({ status: "modified", path });
    else if (token === "D") entries.push({ status: "removed", path });
    i += 1;
  }
  return entries;
}

/** Parse `git diff --numstat -z` (`add\tdelete\tpath\0` per file). */
export function parseNumstatZ(raw: string): Map<string, NumstatEntry> {
  const map = new Map<string, NumstatEntry>();
  for (const record of raw.split("\0").filter((part) => part.length > 0)) {
    const match = /^([^\t]*)\t([^\t]*)\t(.*)$/.exec(record);
    if (!match) continue;
    const addRaw = match[1];
    const delRaw = match[2];
    const path = match[3];
    const binary = addRaw === "-" && delRaw === "-";
    map.set(path, {
      additions: binary ? 0 : Number(addRaw),
      deletions: binary ? 0 : Number(delRaw),
      binary,
    });
  }
  return map;
}

/** Split unified diff output into per-file patch bodies (without diff --git header). */
export function splitDiffPatches(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const chunks = raw.split(/^diff --git /m).filter(Boolean);
  for (const chunk of chunks) {
    const headerEnd = chunk.indexOf("\n");
    if (headerEnd === -1) continue;
    const header = chunk.slice(0, headerEnd);
    const pathMatch = /^a\/(.+?) b\/(.+)$/m.exec(header) ??
      /^a\/(.+?) b\/(.+)$/m.exec(header.replace(/\t.*$/, ""));
    const path = pathMatch?.[2] ?? pathMatch?.[1];
    if (!path) continue;
    const body = chunk.slice(headerEnd + 1);
    const patchStart = body.indexOf("@@");
    map.set(path, patchStart === -1 ? "" : body.slice(patchStart));
  }
  return map;
}
