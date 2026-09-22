/** `co-maintainer view`: print the guides co-maintainer already generated
 * (CORE-23, F25). Read-only and local — the counterpart to `config` for the
 * generated knowledge rather than the settings.
 *
 * Naming: the plan calls the guide kinds `skill`, `codebase`,
 * `review-guide`, `detailed-guide`; `--list` and the headers show the real
 * file names, and a kind name is accepted too so a user never has to type
 * `PR_REVIEW_GUIDE.md` unless they want to. */
import { reposDir } from "../../config.ts";
import { detectRemoteRepo } from "../../local/git_ops.ts";
import { CliError, EXIT_USAGE } from "../error.ts";
import { renderCommandHelp, unknownOptionMessage } from "./registry.ts";
import { readDir, readTextFile, stat } from "../../util/runtime.ts";

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

/** `2026-09-22` from a file's mtime, so a header says when the guide was
 * built without a database lookup. */
function builtDate(mtime: Date): string {
  return mtime.toISOString().slice(0, 10);
}

/** A human size for `--list`, so a glance says whether a guide is present. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

type PresentGuide = { kind: Kind; file: string; size: number; mtime: Date };

/** The guides that actually exist on disk, in {@link GUIDES} order. Missing
 * files are skipped rather than reported: a repo from before PR changes were
 * included legitimately has no detailed guide. */
async function presentGuides(repo: string): Promise<PresentGuide[]> {
  const dir = `${reposDir()}/${repo}`;
  const present: PresentGuide[] = [];
  for (const guide of GUIDES) {
    try {
      const info = await stat(`${dir}/${guide.file}`);
      present.push({
        kind: guide.kind,
        file: guide.file,
        size: info.size,
        mtime: info.mtime,
      });
    } catch {
      // Not generated for this repository.
    }
  }
  return present;
}

/** Every file in the repo's guide directory, so `--list` can also show an
 * unexpected file (an older name, a hand-written note). */
async function listDirectory(
  repo: string,
): Promise<{ file: string; size: number; mtime: Date }[]> {
  const dir = `${reposDir()}/${repo}`;
  const entries: { file: string; size: number; mtime: Date }[] = [];
  try {
    for await (const entry of readDir(dir)) {
      if (!entry.isFile) continue;
      const info = await stat(`${dir}/${entry.name}`);
      entries.push({ file: entry.name, size: info.size, mtime: info.mtime });
    }
  } catch {
    return [];
  }
  return entries.sort((a, b) => a.file.localeCompare(b.file));
}

/** Resolves the repo: the explicit `owner/repo` when given, otherwise the
 * git remote of the current directory. */
async function resolveRepo(args: string[]): Promise<string> {
  const positional = args.find((arg) => !arg.startsWith("-"));
  if (positional && /^[^/]+\/[^/]+$/.test(positional)) return positional;
  return detectRemoteRepo(process.cwd(), positional);
}

export async function runView(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      renderCommandHelp("view") ??
        "Usage: co-maintainer view [owner/repo] [guide]",
    );
    return;
  }
  // `--remote` is CORE-44's server-side listing and not implemented yet, so
  // it is named as such rather than silently ignored like an unknown flag.
  if (args.includes("--remote")) {
    throw new CliError(
      "remote_view_unsupported",
      "view --remote is not available yet.",
      "It will list the guides a remote review server holds (CORE-44).",
      EXIT_USAGE,
    );
  }
  for (const arg of args) {
    if (
      arg.startsWith("--") &&
      !["--list", "--path", "--help", "-h"].includes(arg)
    ) {
      throw new CliError("usage", unknownOptionMessage(arg));
    }
  }
  const repo = await resolveRepo(args);
  const name = args.find((arg) => !arg.startsWith("-") && arg !== repo);

  if (args.includes("--list")) {
    const entries = await listDirectory(repo);
    if (entries.length === 0) {
      throw new CliError(
        "no_guides",
        `No guides for ${repo}.`,
        `co-maintainer probe ${repo}`,
        EXIT_USAGE,
      );
    }
    const width = Math.max(...entries.map((entry) => entry.file.length));
    for (const entry of entries) {
      console.log(
        `${entry.file.padEnd(width)}  ${humanSize(entry.size).padStart(8)}  ${builtDate(entry.mtime)}`,
      );
    }
    return;
  }

  if (args.includes("--path")) {
    console.log(`${reposDir()}/${repo}`);
    return;
  }

  const present = await presentGuides(repo);
  if (present.length === 0) {
    throw new CliError(
      "no_guides",
      `No guides for ${repo}.`,
      `co-maintainer probe ${repo}`,
      EXIT_USAGE,
    );
  }

  if (name) {
    // A single guide is printed raw, with no header, so `view ... | pbcopy`
    // and `view ... > file` produce exactly the markdown.
    const guide = resolveGuide(name);
    const found = present.find((item) => item.file === guide.file);
    if (!found) {
      throw new CliError(
        "guide_missing",
        `${repo} has no ${guide.file}.`,
        `co-maintainer view ${repo} --list`,
        EXIT_USAGE,
      );
    }
    process.stdout.write(
      await readTextFile(`${reposDir()}/${repo}/${guide.file}`),
    );
    return;
  }

  // Every guide, each behind a header that says which file and when it was
  // built, so a scroll through the output never loses its place.
  const blocks: string[] = [];
  for (const guide of present) {
    const body = await readTextFile(`${reposDir()}/${repo}/${guide.file}`);
    blocks.push(
      `== ${guide.file} · built ${builtDate(guide.mtime)} ==\n${body.trimEnd()}`,
    );
  }
  console.log(blocks.join("\n\n"));
}
