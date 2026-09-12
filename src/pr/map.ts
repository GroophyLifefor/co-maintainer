import {
  ensureWorktree,
  pathExists,
  type Run,
  runCommand,
} from "./checkout.ts";
import { ensureCodegraph } from "../tools/codegraph.ts";
import { log } from "../util/log.ts";

/** A repository map for one pull request: the symbols in the files it touches,
 * who calls them, and whether a test reaches them. It answers the questions a
 * diff cannot, such as "is this new branch covered by anything" or "what else
 * depends on the function this line sits in", without pouring whole files into
 * the prompt. */

export type MapResult = {
  text: string;
  queried: string[];
  skipped: { path: string; reason: string }[];
  chars: number;
  worktree: string;
  indexMs: number;
  queryMs: number;
};

/** Only source files carry symbols worth mapping. Everything else in a diff
 * (snapshots, lockfiles, changelogs) would spend the budget on nothing. */
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cc|cpp|cs)$/;

/** `priority` is the scope's own-files set, when known: a re-review round's
 * diff can be almost entirely code that arrived via a merge, and sorting by
 * raw change count alone puts that ahead of the few files the PR actually
 * touched — the map would then describe everything except the change under
 * review. Without a priority set, behavior is unchanged: rank by size alone. */
export function selectFiles(
  files: { path: string; changes: number }[],
  limit: number,
  priority?: Set<string>,
): { queried: string[]; skipped: { path: string; reason: string }[] } {
  const queried: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const ranked = [...files].sort((a, b) => {
    if (priority) {
      const pa = priority.has(a.path) ? 1 : 0;
      const pb = priority.has(b.path) ? 1 : 0;
      if (pa !== pb) return pb - pa;
    }
    return b.changes - a.changes;
  });
  for (const file of ranked) {
    if (!SOURCE.test(file.path)) {
      skipped.push({ path: file.path, reason: "not a source file" });
      continue;
    }
    if (queried.length >= limit) {
      skipped.push({ path: file.path, reason: `over the limit of ${limit}` });
      continue;
    }
    queried.push(file.path);
  }
  return { queried, skipped };
}

async function ensureIndex(
  binary: string,
  worktree: string,
  run: Run,
): Promise<number> {
  const started = performance.now();
  const fresh = !(await pathExists(`${worktree}/.codegraph`));
  const result = await run(binary, [fresh ? "init" : "sync", "."], worktree);
  const ms = performance.now() - started;
  if (result.code !== 0) {
    throw new Error(
      `codegraph ${fresh ? "init" : "sync"} failed: ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  const indexed = result.stdout.match(/Indexed ([\d.]+) files/)?.[1] ??
    result.stdout.match(/Synced (\d+) changed files/)?.[1] ?? "?";
  log(
    "map",
    `codegraph ${fresh ? "init" : "sync"} · ${indexed} files · ${
      (ms / 1000).toFixed(1)
    }s`,
  );
  return ms;
}

/** Keeps the symbol map and drops what is either already in the diff or aimed
 * at a human: numbered source lines, and the trailing hint telling the reader
 * how to fetch the source. */
export function condense(output: string, maxLines = 60): string {
  const keep: string[] = [];
  for (const line of output.split("\n")) {
    const text = line.trimEnd();
    if (text === "") continue;
    if (/^\s*\d+[\t ]/.test(text)) continue;
    if (text.startsWith(">")) continue;
    keep.push(text);
    if (keep.length >= maxLines) {
      keep.push(`[symbol list cut off after ${maxLines} lines]`);
      break;
    }
  }
  return keep.join("\n");
}

export async function buildMap(
  repo: string,
  pr: number,
  commit: string,
  files: { path: string; changes: number }[],
  options: {
    limit?: number;
    allowInstall?: boolean;
    run?: Run;
    priority?: Set<string>;
  } = {},
): Promise<MapResult> {
  const run = options.run ?? runCommand;
  const limit = options.limit ?? 8;
  const binary = await ensureCodegraph({ allowInstall: options.allowInstall });
  const worktree = await ensureWorktree(repo, pr, commit, run);
  const indexMs = await ensureIndex(binary, worktree, run);

  const { queried, skipped } = selectFiles(files, limit, options.priority);
  log(
    "map",
    `querying ${queried.length} of ${files.length} files · skipped ${skipped.length}`,
  );
  const started = performance.now();
  const sections: string[] = [];
  for (const path of queried) {
    const node = await run(
      binary,
      ["node", "--symbols-only", path],
      worktree,
    );
    if (node.code !== 0) {
      skipped.push({ path, reason: `codegraph node exited ${node.code}` });
      continue;
    }
    const body = condense(node.stdout);
    if (body === "") {
      skipped.push({ path, reason: "no symbols in the index" });
      continue;
    }
    sections.push(`### ${path}\n${body}`);
  }
  const queryMs = performance.now() - started;
  const text = sections.length === 0 ? "" : sections.join("\n\n");
  for (const item of skipped) {
    log("map", `skipped ${item.path} · ${item.reason}`);
  }
  log(
    "map",
    `map built · ${sections.length} sections · ${text.length} chars · queries ${
      (queryMs / 1000).toFixed(1)
    }s`,
  );
  return {
    text,
    queried,
    skipped,
    chars: text.length,
    worktree,
    indexMs,
    queryMs,
  };
}
