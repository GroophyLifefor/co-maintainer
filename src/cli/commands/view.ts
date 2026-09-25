/** `co-maintainer view`: print the guides co-maintainer already generated
 * (CORE-23, F25). Read-only — the counterpart to `config` for the generated
 * knowledge rather than the settings.
 *
 * Two sources, one presentation (CORE-44): the guide directory on this machine,
 * or the servers a remote review token can read (`--remote`). Local and remote
 * differ only in where the guide list comes from, so `--list`, a single guide
 * and the every-guide headers are all rendered by the same code.
 *
 * Naming: the plan calls the guide kinds `skill`, `codebase`,
 * `review-guide`, `detailed-guide`; `--list` and the headers show the real
 * file names, and a kind name is accepted too so a user never has to type
 * `PR_REVIEW_GUIDE.md` unless they want to. */
import { readConfig, reposDir } from "../../config.ts";
import { detectRemoteRepo } from "../../local/git_ops.ts";
import { CliError, EXIT_USAGE } from "../error.ts";
import { renderCommandHelp, unknownOptionMessage } from "./registry.ts";
import { readDir, readTextFile, stat } from "../../util/runtime.ts";
import { baseUrl, die, readApiError, remoteFetch } from "../../remote/http.ts";

type Kind = "skill" | "codebase" | "review-guide" | "detailed-guide";

/** The four generated guides, in the order a reader wants them: the
 * contribution skill first, then the codebase notes, then the two review
 * guides (short, then the evidence behind it). */
const GUIDES: { kind: Kind; file: string }[] = [
  { kind: "skill", file: "SKILL.md" },
  { kind: "codebase", file: "CODEBASE.md" },
  { kind: "review-guide", file: "PR_REVIEW_GUIDE.md" },
  { kind: "detailed-guide", file: "PR_REVIEW_DETAILED_GUIDE.md" },
];

/** One guide, from either source. `builtAt` is an ISO timestamp so a local
 * mtime and a remote `builtAt` print through the same formatter. */
type ViewGuide = {
  kind: string;
  file: string;
  size: number;
  builtAt: string;
  content: string;
};

/** Resolves a user-supplied name to a guide. Accepts the plan's kind names
 * (`review-guide`), the file name (`PR_REVIEW_GUIDE.md`), and the bare stem
 * (`PR_REVIEW_GUIDE`), case-insensitively. */
function resolveGuide(name: string): { kind: Kind; file: string } {
  const wanted = name.toLowerCase();
  const match = GUIDES.find(
    (guide) =>
      guide.kind === wanted ||
      guide.file.toLowerCase() === wanted ||
      guide.file.toLowerCase().replace(/\.md$/, "") === wanted,
  );
  if (!match) {
    throw new CliError(
      "unknown_guide",
      `Unknown guide: ${name}.`,
      `Pass one of ${GUIDES.map((guide) => guide.kind).join(", ")}, or --list.`,
      EXIT_USAGE,
    );
  }
  return match;
}

/** `2026-09-22` from an ISO timestamp, so a header says when the guide was
 * built without a database lookup. */
function builtDate(iso: string): string {
  return iso.slice(0, 10);
}

/** A human size for `--list`, so a glance says whether a guide is present. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** The guides that actually exist on disk, in {@link GUIDES} order first so a
 * local listing reads like a remote one. A file co-maintainer did not write
 * (an older name, a hand-written note) is kept, after the four known ones. */
async function readLocalGuides(repo: string): Promise<ViewGuide[]> {
  const dir = `${reposDir()}/${repo}`;
  const names: string[] = [];
  try {
    for await (const entry of readDir(dir)) {
      if (entry.isFile) names.push(entry.name);
    }
  } catch {
    return [];
  }
  const order = (name: string): number => {
    const index = GUIDES.findIndex((guide) => guide.file === name);
    return index === -1 ? GUIDES.length : index;
  };
  const guides: ViewGuide[] = [];
  for (const file of names.sort(
    (a, b) => order(a) - order(b) || a.localeCompare(b),
  )) {
    try {
      const info = await stat(`${dir}/${file}`);
      guides.push({
        kind: GUIDES.find((guide) => guide.file === file)?.kind ?? "other",
        file,
        size: info.size,
        builtAt: info.mtime.toISOString(),
        content: await readTextFile(`${dir}/${file}`),
      });
    } catch {
      // Vanished between the listing and the read: skip it rather than fail
      // the whole directory.
    }
  }
  return guides;
}

type RemoteGuidesResponse = {
  repo?: { fullName?: string };
  guideBuiltAt?: string | null;
  guides?: ViewGuide[];
};

/** The guides a remote review server holds for `repo` (CORE-44). The token is
 * the same one `review --remote` uses, so a host already configured for remote
 * review needs no extra setup. */
async function readRemoteGuides(repo: string): Promise<ViewGuide[]> {
  const config = readConfig();
  const host = config.remoteHost;
  const token = config.remoteToken;
  if (!host || !token) {
    die(
      "remote_not_configured",
      "Remote review is not configured.",
      "co-maintainer config set remote-host https://your-server " +
        "&& co-maintainer config set remote-token <token>",
    );
  }
  const response = await remoteFetch(
    host,
    token,
    `/api/remote/guides?repo=${encodeURIComponent(repo)}`,
    { method: "GET" },
  );
  if (!response.ok) {
    die(
      "remote_guides_failed",
      `The server at ${baseUrl(host)} could not list the guides for ${repo}.`,
      await readApiError(response),
    );
  }
  const body = (await response.json()) as RemoteGuidesResponse;
  return body.guides ?? [];
}

/** Resolves the repo: the explicit `owner/repo` when given, otherwise the
 * git remote of the current directory. */
async function resolveRepo(args: string[]): Promise<string> {
  const positional = args.find((arg) => !arg.startsWith("-"));
  if (positional && /^[^/]+\/[^/]+$/.test(positional)) return positional;
  return detectRemoteRepo(process.cwd(), positional);
}

/** Prints one guide list: `--list` rows, the raw single guide, or every guide
 * behind its own header. Shared by the local and remote sources so the two
 * cannot drift into different outputs. */
function printGuides(
  repo: string,
  guides: ViewGuide[],
  options: { list: boolean; name?: string },
): void {
  if (options.list) {
    const width = Math.max(...guides.map((guide) => guide.file.length));
    for (const guide of guides) {
      console.log(
        `${guide.file.padEnd(width)}  ${humanSize(guide.size).padStart(8)}  ${builtDate(guide.builtAt)}`,
      );
    }
    return;
  }
  if (options.name) {
    // A single guide is printed raw, with no header, so `view ... | pbcopy`
    // and `view ... > file` produce exactly the markdown.
    const wanted = resolveGuide(options.name);
    const found = guides.find((guide) => guide.file === wanted.file);
    if (!found) {
      throw new CliError(
        "guide_missing",
        `${repo} has no ${wanted.file}.`,
        `co-maintainer view ${repo} --list`,
        EXIT_USAGE,
      );
    }
    process.stdout.write(found.content);
    return;
  }
  // Every guide, each behind a header that says which file and when it was
  // built, so a scroll through the output never loses its place.
  console.log(
    guides
      .map(
        (guide) =>
          `== ${guide.file} · built ${builtDate(guide.builtAt)} ==\n${guide.content.trimEnd()}`,
      )
      .join("\n\n"),
  );
}

export async function runView(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      renderCommandHelp("view") ??
        "Usage: co-maintainer view [owner/repo] [guide]",
    );
    return;
  }
  const remote = args.includes("--remote");
  for (const arg of args) {
    if (
      arg.startsWith("--") &&
      !["--list", "--path", "--remote", "--help", "-h"].includes(arg)
    ) {
      throw new CliError("usage", unknownOptionMessage(arg, "view"));
    }
  }
  // The directory belongs to this machine, so it cannot answer for a server.
  if (remote && args.includes("--path")) {
    throw new CliError(
      "usage",
      "--path and --remote cannot be combined.",
      "Drop --remote to print the local guide directory.",
      EXIT_USAGE,
    );
  }
  const repo = await resolveRepo(args);
  const name = args.find((arg) => !arg.startsWith("-") && arg !== repo);

  if (!remote && args.includes("--path")) {
    console.log(`${reposDir()}/${repo}`);
    return;
  }

  const guides = remote
    ? await readRemoteGuides(repo)
    : await readLocalGuides(repo);
  if (guides.length === 0) {
    throw new CliError(
      "no_guides",
      remote
        ? `The server has no guides for ${repo}.`
        : `No guides for ${repo}.`,
      `co-maintainer probe ${repo}`,
      EXIT_USAGE,
    );
  }
  printGuides(repo, guides, {
    list: args.includes("--list"),
    name,
  });
}
