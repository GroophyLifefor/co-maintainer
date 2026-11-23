/** Counts the GitHub calls `probe` and the GitHub half of `init` make, with
 * no AI call. Used to compare a change's before and after on the same repo.
 *
 *   node scripts/github_calls.ts probe owner/repo
 *   node scripts/github_calls.ts init owner/repo --include-pull-requests --max-pr-months=1 --pr-state=merged
 *
 * `init` takes the same read flags as the real command. The cache goes to a
 * fresh temp directory, so every run starts cold and the real cache is not
 * touched. It prints a table and one JSON line to keep. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before any product module reads the cache location.
const cacheRoot = mkdtempSync(join(tmpdir(), "cm-github-calls-"));
process.env.XDG_CACHE_HOME = cacheRoot;
process.env.LOCALAPPDATA = cacheRoot;

const { parseArgs } = await import("../src/cli/args.ts");
const { clientFor } = await import("../src/services/setup.ts");
const { probePlan } = await import("../src/services/probe.ts");
const { collectSource } = await import("../src/github/collect.ts");
type GitHubClient = import("../src/types.ts").GitHubClient;

/** `/rate_limit` costs no quota, so it is listed but left out of the total. */
const FREE = "rate limit (free)";

/** The kind of call an endpoint is, so before and after compare by kind. */
export function callKind(endpoint: string): string {
  const path = endpoint.split("?")[0]!;
  if (path === "graphql") return "graphql";
  if (path === "rate_limit") return FREE;
  if (/\/pulls\/\d+\/files$/.test(path)) return "pull files";
  if (/\/pulls\/\d+\/comments$/.test(path)) return "pull review comments";
  if (/\/pulls\/\d+\/reviews$/.test(path)) return "pull reviews";
  if (/\/issues\/\d+\/comments$/.test(path)) return "pull comments";
  if (/\/pulls\/\d+$/.test(path)) return "pull detail";
  if (path.endsWith("/pulls")) return "pull listing";
  if (path.endsWith("/commits")) return "commit listing";
  if (/\/contents\//.test(path)) return "file";
  if (/\/git\/trees\//.test(path)) return "tree";
  if (path.endsWith("/releases")) return "releases";
  if (/^repos\/[^/]+\/[^/]+$/.test(path)) return "repository";
  return "other";
}

type Counts = Map<string, number>;

function counting(client: GitHubClient, counts: Counts): GitHubClient {
  const add = (endpoint: string, calls: number) => {
    const kind = callKind(endpoint);
    counts.set(kind, (counts.get(kind) ?? 0) + calls);
  };
  return {
    ...client,
    request: async <T>(endpoint: string): Promise<T> => {
      add(endpoint, 1);
      return client.request<T>(endpoint);
    },
    pages: async <T>(
      endpoint: string,
      limit?: number,
      progress?: (page: number, fetched: number) => void,
    ): Promise<T[]> => {
      let pages = 0;
      try {
        return await client.pages<T>(endpoint, limit, (page, fetched) => {
          pages = page;
          progress?.(page, fetched);
        });
      } finally {
        add(endpoint, Math.max(1, pages));
      }
    },
    ...(client.write
      ? {
          write: async <T>(endpoint: string, body: unknown): Promise<T> => {
            add(endpoint, 1);
            return client.write!<T>(endpoint, body);
          },
        }
      : {}),
  };
}

const [mode, repo, ...flags] = process.argv.slice(2);
if ((mode !== "probe" && mode !== "init") || !repo) {
  console.error(
    "usage: node scripts/github_calls.ts probe|init owner/repo [init read flags]",
  );
  process.exit(2);
}

const options = await parseArgs([mode, repo, ...flags]);
const raw = clientFor(options);
const counts: Counts = new Map();
const client = counting(raw, counts);

const started = performance.now();
if (mode === "probe") {
  await probePlan(client, repo, {
    ghConcurrent: options.ghConcurrent,
    log: (message) => console.error(`[probe] ${message}`),
  });
} else {
  await collectSource(client, options);
}
const seconds = Math.round((performance.now() - started) / 100) / 10;

const total = [...counts.entries()]
  .filter(([kind]) => kind !== FREE)
  .reduce((sum, [, value]) => sum + value, 0);
const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);

console.log(`\n${mode} ${repo} ${flags.join(" ")}`.trimEnd());
console.log("\n| Call | Count |\n| --- | --- |");
for (const [kind, count] of rows) console.log(`| ${kind} | ${count} |`);
console.log(`| **total** | **${total}** |`);
console.log(`\nseconds: ${seconds}`);
console.log(
  `\n${JSON.stringify({ mode, repo, flags, total, calls: Object.fromEntries(rows), seconds })}`,
);
