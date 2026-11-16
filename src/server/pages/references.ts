/** A finding's references on the dashboard: the same collapsed list a review
 * comment shows when the repository turns references on, shown here always. */
import {
  parseStoredReferences,
  type ReferenceSource,
  type ResolvedReference,
} from "../../review/references.ts";
import { text } from "./layout.ts";

/** Only GitHub links are made clickable. Anything else is plain text. */
function linked(label: string, url: string | undefined): string {
  return url && url.startsWith("https://github.com/")
    ? `<a href="${text(url)}" target="_blank" rel="noopener noreferrer">${text(label)}</a>`
    : text(label);
}

function sourceLinks(sources: ReferenceSource[]): string {
  return sources
    .map((source) =>
      "pr" in source
        ? linked(`#${source.pr}`, source.url)
        : linked(`${source.path}:${source.line}`, source.url),
    )
    .join(", ");
}

function referenceItem(reference: ResolvedReference): string {
  switch (reference.kind) {
    case "system":
      return text("System Prompt");
    case "codebase":
      return text(
        reference.section ? `Codebase · ${reference.section}` : "Codebase",
      );
    case "rule": {
      const newest = reference.sources
        .flatMap((source) =>
          "pr" in source && source.mergedAt ? [source.mergedAt] : [],
        )
        .sort()
        .at(-1)
        ?.slice(0, 7);
      return [
        text(`Rules-${reference.id.slice(1)}`),
        sourceLinks(reference.sources),
        newest ? text(newest) : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "instruction":
      return [
        text(`Instructions-${reference.id.slice(1)}`),
        sourceLinks(reference.sources),
      ]
        .filter(Boolean)
        .join(" · ");
  }
}

/** The collapsed block, or `""` for a finding stored before references. */
export function referencesHtml(stored: string | null | undefined): string {
  const references = parseStoredReferences(stored);
  if (references.length === 0) return "";
  return `<details style="margin-top:8px"><summary class="muted" style="font-size:13px;cursor:pointer">${text(
    `References (${references.length})`,
  )}</summary><ul style="margin:6px 0 0 18px;font-size:13px">${references
    .map((reference) => `<li>${referenceItem(reference)}</li>`)
    .join("")}</ul></details>`;
}
