/** The extensions in the GitHub review `serve` posts.
 *
 * - A finding on a diff line goes inline, headed with its label.
 * - A finding off the diff, or with no location, goes in the summary list
 *   with the same label. It is never an inline comment.
 * - `#### Extensions` follows the review summary, one `<details>` per
 *   extension holding its `markdown`.
 * - Metadata names which extensions ran, failed, skipped and requested
 *   changes.
 * - A failure does not block. The summary says it failed and points at the
 *   dashboard, where the reason and the output are kept.
 *
 * The whole body stays under 250,000 characters by dropping `markdown`,
 * longest first. The AI review is never cut. */
import { anchorFor, type Anchor } from "../pr/hunks.ts";
import type { Json } from "../types.ts";
import { locationOf } from "./render_cli.ts";
import {
  extensionLabel,
  extensionsBlock,
  namesWith,
  type ExtensionFinding,
  type ExtensionReport,
} from "./report.ts";
import {
  extensionsSection,
  fitMarkdowns,
  REVIEW_BODY_MAX_CHARS,
  REVIEW_LIMIT_NOTE,
} from "./render_markdown.ts";

/** The copy rule every posted text passes through (`humanCopy`). Passed in so
 * this file does not import the review service that imports it. */
export type Copy = (text: string) => string;

export type InlineComment = {
  path: string;
  body: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
};

function inlineBody(
  report: ExtensionReport,
  finding: ExtensionFinding,
  copy: Copy,
): string {
  const body = copy(finding.body).trim();
  return `${extensionLabel(report, finding)}\n\n**${copy(finding.title)}**${body ? `\n\n${body}` : ""}`;
}

/** Splits the findings still standing into inline comments and the ones the
 * summary lists. Only a finding new this round goes inline: a still open one
 * was commented on when it was new. */
export function splitExtensionFindings(
  report: ExtensionReport,
  files: Json[],
  copy: Copy,
): { comments: InlineComment[]; listed: ExtensionFinding[] } {
  const patches = new Map(
    files.map((file) => [
      String(file.filename ?? ""),
      String(file.patch ?? ""),
    ]),
  );
  const comments: InlineComment[] = [];
  const listed: ExtensionFinding[] = [];
  for (const finding of report.findings) {
    if (finding.state === "closed") continue;
    const patch = finding.path ? patches.get(finding.path) : undefined;
    const anchor: Anchor | undefined =
      finding.state === "new" && patch !== undefined && finding.lineFrom
        ? anchorFor(patch, finding.lineFrom, finding.lineTo ?? finding.lineFrom)
        : undefined;
    if (!anchor || !finding.path) {
      listed.push(finding);
      continue;
    }
    comments.push({
      path: finding.path,
      body: inlineBody(report, finding, copy),
      line: anchor.line,
      side: "RIGHT",
      ...(anchor.start_line === undefined
        ? {}
        : { start_line: anchor.start_line, start_side: "RIGHT" as const }),
    });
  }
  return { comments, listed };
}

function bracket(names: string[]): string {
  return `[${names.join(", ")}]`;
}

/** The lines Metadata gains. */
export function extensionMetadataLines(report: ExtensionReport): string[] {
  const failed = namesWith(report, "failed");
  const skipped = namesWith(report, "skipped");
  const requested = report.results
    .filter(
      (result) =>
        result.status === "ok" && result.verdict === "request_changes",
    )
    .map((result) => result.name);
  return [
    `- Extensions: ${bracket(namesWith(report, "ok"))}`,
    ...(failed.length ? [`- Failed Extensions: ${bracket(failed)}`] : []),
    ...(skipped.length ? [`- Skipped Extensions: ${bracket(skipped)}`] : []),
    ...(requested.length ? [`- Requested changes: ${bracket(requested)}`] : []),
  ];
}

const METADATA_START = "\n\n<details>\n<summary>Metadata</summary>";

/** The review body with the extensions in it. `body` is the AI review's own
 * body, which always ends in its Metadata block. */
export function reviewBodyWithExtensions(
  body: string,
  report: ExtensionReport,
  listed: ExtensionFinding[],
  copy: Copy,
): string {
  if (report.results.length === 0) return body;
  const at = body.lastIndexOf(METADATA_START);
  let summary = at === -1 ? body : body.slice(0, at);
  const metadata = at === -1 ? "" : body.slice(at);
  const standing = report.findings.some((row) => row.state !== "closed");
  if (standing && summary.startsWith("No actionable findings.")) {
    summary = summary.replace(
      "No actionable findings.",
      "The AI review found nothing to fix.",
    );
  }
  const parts: string[] = [];
  if (listed.length > 0) {
    parts.push(
      [
        `Extension findings (${listed.length})`,
        ...listed.map((row) => {
          const where = locationOf(row);
          return `- ${extensionLabel(report, row)}: ${copy(row.title)}${where ? ` (${copy(where)})` : ""}${row.state === "open" ? " (still open)" : ""}`;
        }),
      ].join("\n"),
    );
  }
  const failed = namesWith(report, "failed");
  if (failed.length > 0) {
    parts.push(
      failed
        .map(
          (name) =>
            `${name} extension failed, you can see details in dashboard`,
        )
        .join("\n"),
    );
  }
  const withMetadata = metadata.replace(
    /\n<\/details>$/,
    `\n${extensionMetadataLines(report).join("\n")}\n</details>`,
  );
  return fitMarkdowns(
    report,
    (markdowns) => {
      const section = extensionsSection(report, markdowns);
      const sanitized = section ? copy(section) : "";
      return (
        [summary, ...parts, ...(sanitized ? [sanitized] : [])].join("\n\n") +
        withMetadata
      );
    },
    REVIEW_BODY_MAX_CHARS,
    (text) => text.length,
    REVIEW_LIMIT_NOTE,
  );
}

/** One extension's `request_changes` makes the review Request changes. A
 * review the AI would approve only comments while an extension finding
 * stands. */
export function reviewEventWithExtensions(
  event: "REQUEST_CHANGES" | "COMMENT" | "APPROVE",
  report: ExtensionReport,
): "REQUEST_CHANGES" | "COMMENT" | "APPROVE" {
  if (extensionsBlock(report)) return "REQUEST_CHANGES";
  if (
    event === "APPROVE" &&
    report.findings.some((row) => row.state !== "closed")
  ) {
    return "COMMENT";
  }
  return event;
}

/** Findings still standing, for the check run's conclusion. */
export function standingExtensionFindings(report: ExtensionReport): number {
  return report.findings.filter((row) => row.state !== "closed").length;
}
