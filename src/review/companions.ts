/** Companion changes (issue 81): the changes another repository made for the
 * same task, read as context and never reviewed. A review gets one COMPANION
 * block per companion in its user prompt, listing the changed files. The
 * patches stay out of the prompt and the model reads them with
 * `read-full-diff`. A review without companions sends the bytes it always
 * did. */
import { createHash } from "node:crypto";
import type { RevisionFile } from "./revision.ts";

/** The most companions one review reads. */
export const MAX_COMPANIONS = 5;

/** The most files one COMPANION block lists. The rest is one `and N more`
 * line. */
export const COMPANION_LIST_MAX_FILES = 200;

/** The widest a listed path is padded to, so a line stays near 100
 * characters. A longer path is listed whole. */
const PATH_COLUMN_MAX = 72;

/** The most patch characters a remote server takes for all companions of a
 * review together. Above it the server keeps the file lists only. */
export const COMPANION_PATCH_MAX_CHARS = 500_000;

/** Where a companion came from. Only `--with` in this release. */
export type CompanionSource = "flag";

/** One companion as a review reads it. */
export type Companion = {
  /** `owner/repo`, from the companion's git remote. */
  repo: string;
  branch: string;
  files: RevisionFile[];
  /** Its text must not be quoted in this review: a private companion in a
   * review of a public repository, or one whose visibility could not be
   * read. Its patches and search results go through the copied-passage
   * check. */
  private: boolean;
};

/** The sentence before the COMPANION blocks. */
export const COMPANION_PROMPT =
  "COMPANION blocks list changes in other repositories that belong to this change. They are context. Report findings only on this repository's files, and name the companion file in the body when it is the reason.";

/** A companion file's path as the prompt and `read-full-diff` name it. The
 * repository name in front keeps it apart from the reviewed change. */
export function companionPath(repo: string, path: string): string {
  return `${repo}:${path}`;
}

/** Control characters and the line separators U+2028 and U+2029. */
const BREAKS = new RegExp(
  `[\\u0000-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  "g",
);

/** Text that came from another checkout or a client, on one line. */
function oneLine(text: string): string {
  return text.replace(BREAKS, " ");
}

/** One companion's block. */
export function companionBlock(companion: Companion): string {
  const repo = oneLine(companion.repo);
  const head = `COMPANION ${repo} · branch ${oneLine(companion.branch)}`;
  const files = companion.files;
  if (files.length === 0) return `${head} · no changes on this branch`;
  const listed = files.slice(0, COMPANION_LIST_MAX_FILES);
  const paths = listed.map((file) => oneLine(companionPath(repo, file.path)));
  const width = Math.min(
    PATH_COLUMN_MAX,
    Math.max(...paths.map((path) => path.length)),
  );
  const lines = listed.map((file, index) => {
    const path = paths[index]!;
    const gap = " ".repeat(Math.max(3, width + 3 - path.length));
    return `${path}${gap}${file.status.padEnd(10)}+${file.additions} -${file.deletions}`;
  });
  const rest = files.length - listed.length;
  if (rest > 0) lines.push(`and ${rest} more`);
  const count = `${files.length} ${files.length === 1 ? "file" : "files"} changed`;
  return [`${head} · ${count}`, ...lines].join("\n");
}

/** What the user prompt gains: the sentence and the blocks, with the blank
 * lines that join them to the block before. `""` without companions, so the
 * prompt keeps its old bytes. */
export function companionSection(companions: Companion[] | undefined): string {
  if (!companions?.length) return "";
  return `\n\n${COMPANION_PROMPT}\n\n${companions.map(companionBlock).join("\n\n")}`;
}

/** A hash of a companion's file list and patches. A different hash means
 * the companion changed since the round that saved the other one. */
export function companionHash(files: RevisionFile[]): string {
  const rows = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => [
      file.path,
      file.previousPath ?? "",
      file.status,
      file.binary,
      file.additions,
      file.deletions,
      file.patch,
    ]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** What a carry record keeps of a companion. */
export type CompanionRecord = { repo: string; branch: string; hash: string };

export function companionRecords(companions: Companion[]): CompanionRecord[] {
  return companions.map((companion) => ({
    repo: companion.repo,
    branch: companion.branch,
    hash: companionHash(companion.files),
  }));
}

/** True when the companions differ from the ones the last round saved: one
 * changed its files, or one was added or left out. A record saved before
 * companions existed has none. */
export function companionsChanged(
  before: CompanionRecord[] | undefined,
  now: CompanionRecord[],
): boolean {
  const key = (list: CompanionRecord[]) =>
    list
      .map((item) => `${item.repo.toLowerCase()}\0${item.branch}\0${item.hash}`)
      .sort()
      .join("\n");
  return key(before ?? []) !== key(now);
}

/** One companion in a `--json` result. */
export type CompanionJson = {
  repo: string;
  branch: string;
  source: CompanionSource;
  pr: null;
  files: number;
  status: "read" | "empty";
};

export function companionsJson(companions: Companion[]): CompanionJson[] {
  return companions.map((companion) => ({
    repo: companion.repo,
    branch: companion.branch,
    source: "flag",
    pr: null,
    files: companion.files.length,
    status: companion.files.length === 0 ? "empty" : "read",
  }));
}

/** The line a review prints under its header, in the terminal and in the
 * job summary. */
export function companionsLine(companions: CompanionJson[]): string {
  const items = companions.map((companion) => {
    const counted =
      companion.files === 0
        ? "no changes"
        : `${companion.files} ${companion.files === 1 ? "file" : "files"}`;
    return `${oneLine(companion.repo)}@${oneLine(companion.branch)} (${counted})`;
  });
  return `Companions: ${items.join(" · ")}`;
}
