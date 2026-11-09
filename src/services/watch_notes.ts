/** What `sync` does with the notes maintainers left on commit watch issues.
 *
 * Each new note is turned into one guide line by the low model. The lines go
 * into the detailed review guide, so every later review knows them. A note
 * that said to ignore the finding also marks its issue ignored, the hard
 * filter: no issue, comment or report for that finding again. */
import {
  getWatchIssue,
  listWatchNotes,
  markWatchNoteApplied,
  updateWatchIssue,
  type WatchNoteRow,
} from "../store/watch.ts";
import { log } from "../util/log.ts";
import type { AiProvider, AiResponse } from "../types.ts";

const SECTION_START = "<!-- co-maintainer:maintainer-notes -->";
const SECTION_TITLE = "## Maintainer notes";

function notePrompt(
  note: WatchNoteRow,
  issueTitle: string,
  path: string | null,
): string {
  return `A maintainer replied on an issue an automated code reviewer opened.
Turn the reply into one line for the repository's review guide: a general
statement a future reviewer must follow, in English, at most 200 characters,
with no names, mentions, issue numbers or quotes. Return only that line.

The reviewer had reported: ${issueTitle}${path ? ` (in ${path})` : ""}
The maintainer ${note.kind === "ignore" ? "said to ignore it" : "added information"}:
${note.body.slice(0, 4000)}`;
}

function oneLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/@[A-Za-z0-9_-]{2,}/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[-*\s]+/, "")
    .trim()
    .slice(0, 300);
}

/** Applies the notes left since the last sync and returns every note line,
 * old and new, for the detailed guide. With no app.db (a CLI sync on another
 * machine) there are no notes. */
export async function applyWatchNotes(
  repo: string,
  lowAi: AiProvider,
  usage?: (response: AiResponse) => Promise<void> | void,
): Promise<string[]> {
  let notes: WatchNoteRow[];
  try {
    notes = listWatchNotes(repo);
  } catch {
    return [];
  }
  for (const note of notes) {
    if (note.applied_at) continue;
    const issue = getWatchIssue(repo, note.issue_number);
    const response = await lowAi.complete({
      job: "watch_note",
      prompt: notePrompt(
        note,
        issue?.title ?? "a finding",
        issue?.path ?? null,
      ),
      maxTokens: 300,
    });
    await usage?.(response);
    const line = oneLine(response.text) || oneLine(note.body);
    const about = issue?.path ? ` (about \`${issue.path}\`)` : "";
    note.note = `${line}${about}`;
    markWatchNoteApplied(note.id, note.note);
    if (note.kind === "ignore" && issue) {
      updateWatchIssue(issue.id, { state: "ignored" });
    }
    log(
      "write",
      `maintainer note from issue #${note.issue_number} added to the guide`,
    );
  }
  return notes
    .map((note) => note.note)
    .filter((line): line is string => Boolean(line));
}

/** The guide with its maintainer notes section replaced by `lines`. The
 * section is always last and starts with a marker, so it can be found again. */
export function withMaintainerNotes(guide: string, lines: string[]): string {
  const at = guide.indexOf(SECTION_START);
  const body = (at === -1 ? guide : guide.slice(0, at)).trimEnd();
  if (lines.length === 0) return body ? `${body}\n` : "";
  const section = [
    SECTION_START,
    SECTION_TITLE,
    "",
    "Maintainers said these on commit watch issues. Follow them in every review.",
    "",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
  return body ? `${body}\n\n${section}\n` : `# Review notes\n\n${section}\n`;
}
