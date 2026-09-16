import type { ParsedFinding } from "../pr/findings.ts";
import { spansOverlap } from "../pr/rounds.ts";
import { rightLines } from "../pr/hunks.ts";
import {
  normalizeAnchor,
  normalizeBody,
  normalizePath,
  revisionFilesEquivalent,
  resolvePathAfterRename,
  type Revision,
  type RevisionFile,
} from "./revision.ts";

export type StoredFinding = {
  id: string;
  path: string | null;
  lineFrom: number | null;
  lineTo: number | null;
  title: string;
  bodyMd: string;
  anchorText: string | null;
  severity: string;
  firstSeenReviewId: string | null;
};

export type CarryPrevious = {
  files: RevisionFile[];
  visiblePaths: Set<string>;
  findings: StoredFinding[];
  guideBuiltAt: string | null;
};

export type CarryClass =
  | "file_reverted"
  | "file_removed"
  | "unverifiable"
  | "verify_guide_changed"
  | "unchanged"
  | "verify_present"
  | "verify_likely_fixed"
  | "verify_unlocated";

export type CarryItem = {
  id: string;
  finding: StoredFinding;
  class: CarryClass;
  targetPath: string | null;
  lineFrom: number;
  lineTo: number;
};

export type ResolvedFinding = {
  id: string;
  state: "new" | "open" | "closed";
  closeReason?: "fixed" | "file_reverted";
  path: string | null;
  lineFrom: number | null;
  lineTo: number | null;
  title: string;
  bodyMd: string;
  anchorText: string | null;
  severity: string;
  carriedFromId: string | null;
  firstSeenReviewId: string | null;
};

export function anchorTextFromPatch(
  patch: string,
  from: number,
  to: number,
): string | null {
  const lines = rightLines(patch);
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const picked: string[] = [];
  for (let line = low; line <= high; line++) {
    const text = lines.get(line);
    if (text === undefined) return null;
    picked.push(text.replace(/\r$/, "").trimEnd());
  }
  return picked.length ? picked.join("\n") : null;
}

function anchorInPatch(anchor: string | null, patch: string): boolean {
  if (!anchor) return false;
  const want = normalizeAnchor(anchor).split("\n");
  const numbered = [...rightLines(patch).entries()].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i <= numbered.length - want.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (normalizeAnchor(numbered[i + j][1]) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export function relocate(
  anchorText: string | null,
  oldFrom: number,
  patch: string,
): { from: number; to: number } | null {
  if (!anchorText) return null;
  const want = normalizeAnchor(anchorText).split("\n");
  if (want.length === 0) return null;
  const numbered = [...rightLines(patch).entries()].sort((a, b) => a[0] - b[0]);
  const matches: { from: number; to: number; distance: number }[] = [];
  for (let i = 0; i <= numbered.length - want.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (normalizeAnchor(numbered[i + j][1]) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const from = numbered[i][0];
    const to = numbered[i + want.length - 1][0];
    matches.push({
      from,
      to,
      distance: Math.abs(from - oldFrom),
    });
  }
  if (matches.length === 0) return null;
  if (
    want.length === 1 &&
    want[0].length < 12 &&
    matches.length > 1
  ) {
    return null;
  }
  matches.sort((a, b) => a.distance - b.distance || a.from - b.from);
  const best = matches[0];
  return { from: best.from, to: best.to };
}

function guideChanged(
  previous: CarryPrevious,
  currentGuideBuiltAt: string | null,
): boolean {
  return (previous.guideBuiltAt ?? "") !== (currentGuideBuiltAt ?? "");
}

export function classifyCarryItems(
  previous: CarryPrevious,
  current: Revision,
  visiblePaths: Set<string>,
  currentGuideBuiltAt: string | null,
): CarryItem[] {
  const currentByPath = new Map(
    current.files.map((file) => [normalizePath(file.path), file]),
  );
  const items: CarryItem[] = [];
  for (const finding of previous.findings) {
    const targetPath = finding.path
      ? resolvePathAfterRename(current, finding.path)
      : null;
    const file = targetPath
      ? currentByPath.get(normalizePath(targetPath))
      : undefined;
    const lineFrom = finding.lineFrom ?? 0;
    const lineTo = finding.lineTo ?? lineFrom;
    let klass: CarryClass = "verify_unlocated";
    const prevFile = finding.path
      ? previous.files.find((f) =>
        normalizePath(f.path) === normalizePath(finding.path!)
      )
      : undefined;
    const prevPatch = prevFile?.patch ?? "";
    const sameBody = prevFile && file &&
      normalizeBody(prevPatch) === normalizeBody(file.patch);

    if (!finding.path) {
      klass = "unverifiable";
    } else if (!targetPath || !file) {
      klass = "file_reverted";
    } else if (file.status === "removed") {
      klass = "file_removed";
    } else if (
      finding.path && !previous.visiblePaths.has(normalizePath(finding.path))
    ) {
      klass = "unverifiable";
    } else if (sameBody) {
      klass = "unchanged";
    } else if (!visiblePaths.has(normalizePath(file.path))) {
      klass = "unverifiable";
    } else if (guideChanged(previous, currentGuideBuiltAt)) {
      klass = "verify_guide_changed";
    } else {
      if (anchorInPatch(finding.anchorText, file.patch)) {
        klass = "verify_present";
      } else if (
        finding.anchorText &&
        finding.anchorText.split("\n").every((line) =>
          line.trim().startsWith("+")
        )
      ) {
        klass = "verify_likely_fixed";
      } else {
        klass = "verify_unlocated";
      }
    }

    items.push({
      id: finding.id,
      finding,
      class: klass,
      targetPath,
      lineFrom,
      lineTo,
    });
  }
  return items;
}

const VERIFY_HINT: Record<CarryClass, string> = {
  file_reverted: "",
  file_removed: "",
  unverifiable: "",
  verify_guide_changed: "review guide was rebuilt",
  unchanged: "",
  verify_present: "still present in changed code",
  verify_likely_fixed: "anchored code no longer found",
  verify_unlocated: "could not locate",
};

export function buildCarryPromptSection(
  items: CarryItem[],
  current: Revision,
): string {
  const verify: string[] = [];
  const unchanged: string[] = [];
  let index = 0;
  for (const item of items) {
    if (item.class === "file_reverted" || item.class === "file_removed") {
      continue;
    }
    if (item.class === "unchanged") {
      const file = current.files.find((f) =>
        normalizePath(f.path) === normalizePath(item.targetPath ?? "")
      );
      const relocated = file
        ? relocate(item.finding.anchorText, item.lineFrom, file.patch)
        : null;
      const from = relocated?.from ?? item.lineFrom;
      const to = relocated?.to ?? item.lineTo;
      unchanged.push(
        `- ${item.targetPath}:${from}${
          to !== from ? `-${to}` : ""
        } · ${item.finding.title}`,
      );
      continue;
    }
    if (
      item.class === "unverifiable"
    ) {
      continue;
    }
    index++;
    const label = `F${index}`;
    (item as CarryItem & { promptId?: string }).promptId = label;
    const loc = item.targetPath
      ? `${item.targetPath}:${item.lineFrom}${
        item.lineTo !== item.lineFrom ? `-${item.lineTo}` : ""
      }`
      : "";
    const body = item.finding.bodyMd.slice(0, 600);
    verify.push(
      `${label} · ${
        VERIFY_HINT[item.class]
      } · ${loc}\n${item.finding.title}\n${body}`,
    );
  }
  if (verify.length === 0 && unchanged.length === 0) return "";
  const lines = [
    "PREVIOUS FINDINGS:",
    "These were raised by an earlier review of this same change. For each one",
    "listed under VERIFY, decide whether the code in the DIFF still has the",
    'problem. Report every decision in a final "## Previous findings" section,',
    'one line per id, exactly as "- F1: open path:from-to" or "- F1: closed".',
    'Do not repeat an open previous finding under "## Findings".',
    "",
  ];
  if (verify.length) {
    lines.push("VERIFY:", verify.join("\n\n"), "");
  }
  if (unchanged.length) {
    lines.push(
      "STILL OPEN, UNCHANGED (do not report again):",
      unchanged.join("\n"),
      "",
    );
  }
  return lines.join("\n");
}

export type PreviousVerdict = {
  id: string;
  state: "open" | "closed";
  path?: string;
  from?: number;
  to?: number;
};

export function parsePreviousVerdicts(markdown: string): PreviousVerdict[] {
  const heading = markdown.search(/^## Previous findings\b/im);
  if (heading === -1) return [];
  const section = markdown.slice(heading);
  const verdicts: PreviousVerdict[] = [];
  const lineRe =
    /^-\s*(F\d+)\s*:\s*(open|closed)(?:\s+([^:\s]+):(\d+)(?:-(\d+))?)?\s*$/im;
  for (const line of section.split("\n")) {
    const match = lineRe.exec(line.trim());
    if (!match) continue;
    verdicts.push({
      id: match[1],
      state: match[2].toLowerCase() as "open" | "closed",
      path: match[3],
      from: match[4] ? Number(match[4]) : undefined,
      to: match[5] ? Number(match[5]) : match[4] ? Number(match[4]) : undefined,
    });
  }
  return verdicts;
}

export function findingsMarkdownForParse(markdown: string): string {
  const cut = markdown.search(/^## Previous findings\b/im);
  return cut === -1 ? markdown : markdown.slice(0, cut);
}

export function resolveCarryOutcomes(
  items: CarryItem[],
  current: Revision,
  visiblePaths: Set<string>,
  verdicts: PreviousVerdict[],
  parsedNew: ParsedFinding[],
  currentGuideBuiltAt: string | null,
  previous: CarryPrevious,
): ResolvedFinding[] {
  const verdictByPromptId = new Map(verdicts.map((v) => [v.id, v]));
  const promptIds = new Map<string, string>();
  let seq = 0;
  for (const item of items) {
    if (
      item.class === "file_reverted" ||
      item.class === "file_removed" ||
      item.class === "unchanged" ||
      item.class === "unverifiable"
    ) {
      continue;
    }
    seq++;
    promptIds.set(item.finding.id, `F${seq}`);
  }

  const resolved: ResolvedFinding[] = [];
  const openForMerge: ResolvedFinding[] = [];

  for (const item of items) {
    const base = item.finding;
    if (item.class === "file_reverted") {
      resolved.push({
        id: crypto.randomUUID(),
        state: "closed",
        closeReason: "file_reverted",
        path: base.path,
        lineFrom: base.lineFrom,
        lineTo: base.lineTo,
        title: base.title,
        bodyMd: base.bodyMd,
        anchorText: base.anchorText,
        severity: base.severity,
        carriedFromId: base.id,
        firstSeenReviewId: base.firstSeenReviewId,
      });
      continue;
    }
    if (item.class === "file_removed") {
      resolved.push({
        id: crypto.randomUUID(),
        state: "closed",
        closeReason: "fixed",
        path: base.path,
        lineFrom: base.lineFrom,
        lineTo: base.lineTo,
        title: base.title,
        bodyMd: base.bodyMd,
        anchorText: base.anchorText,
        severity: base.severity,
        carriedFromId: base.id,
        firstSeenReviewId: base.firstSeenReviewId,
      });
      continue;
    }

    const file = item.targetPath
      ? current.files.find((f) =>
        normalizePath(f.path) === normalizePath(item.targetPath!)
      )
      : undefined;
    let lineFrom = item.lineFrom;
    let lineTo = item.lineTo;
    if (item.class === "unchanged" && file) {
      const moved = relocate(base.anchorText, lineFrom, file.patch);
      if (moved) {
        lineFrom = moved.from;
        lineTo = moved.to;
      }
    }

    if (item.class === "unchanged" || item.class === "unverifiable") {
      const row: ResolvedFinding = {
        id: crypto.randomUUID(),
        state: "open",
        path: item.targetPath ?? base.path,
        lineFrom,
        lineTo,
        title: base.title,
        bodyMd: base.bodyMd,
        anchorText: file
          ? anchorTextFromPatch(file.patch, lineFrom, lineTo)
          : base.anchorText,
        severity: base.severity,
        carriedFromId: base.id,
        firstSeenReviewId: base.firstSeenReviewId,
      };
      resolved.push(row);
      openForMerge.push(row);
      continue;
    }

    const promptId = promptIds.get(base.id);
    const verdict = promptId ? verdictByPromptId.get(promptId) : undefined;
    const state = verdict?.state ?? "open";
    const anchor = file && verdict?.path
      ? anchorTextFromPatch(
        file.patch,
        verdict.from ?? lineFrom,
        verdict.to ?? verdict.from ?? lineTo,
      )
      : base.anchorText;
    const row: ResolvedFinding = {
      id: crypto.randomUUID(),
      state,
      path: verdict?.path ?? item.targetPath ?? base.path,
      lineFrom: verdict?.from ?? lineFrom,
      lineTo: verdict?.to ?? verdict?.from ?? lineTo,
      title: base.title,
      bodyMd: base.bodyMd,
      anchorText: anchor,
      severity: base.severity,
      carriedFromId: base.id,
      firstSeenReviewId: base.firstSeenReviewId,
    };
    resolved.push(row);
    if (state === "open") openForMerge.push(row);
  }

  for (const finding of parsedNew) {
    const overlap = openForMerge.find((open) =>
      open.path &&
      spansOverlap(
        { path: open.path, from: open.lineFrom ?? 0, to: open.lineTo ?? 0 },
        finding,
      )
    );
    if (overlap) {
      overlap.bodyMd = finding.excerpt;
      overlap.title = finding.heading || finding.path;
      overlap.lineFrom = finding.from;
      overlap.lineTo = finding.to;
      continue;
    }
    resolved.push({
      id: crypto.randomUUID(),
      state: "new",
      path: finding.path,
      lineFrom: finding.from,
      lineTo: finding.to,
      title: finding.heading || finding.path,
      bodyMd: finding.excerpt,
      anchorText: null,
      severity: finding.severity ?? "P2",
      carriedFromId: null,
      firstSeenReviewId: null,
    });
  }

  return resolved;
}

export function incrementalDiffPaths(
  current: Revision,
  previousFiles: RevisionFile[] | null,
): { changed: RevisionFile[]; unchanged: string[] } {
  if (!previousFiles) {
    return { changed: current.files, unchanged: [] };
  }
  const prevByPath = new Map(
    previousFiles.map((file) => [normalizePath(file.path), file]),
  );
  const changed: RevisionFile[] = [];
  const unchanged: string[] = [];
  for (const file of current.files) {
    const prev = prevByPath.get(normalizePath(file.path));
    if (!prev || !revisionFilesEquivalent(prev, file)) {
      changed.push(file);
    } else {
      unchanged.push(file.path);
    }
  }
  return { changed, unchanged };
}
