/** What companions add to a review's tools and findings (issue 81):
 * `read-full-diff` reads a companion file by its `owner/repo:path`,
 * `search-non-code` takes a `repo` and searches a companion, and a finding
 * the model places on a companion file goes to the summary without a
 * location. Without companions every tool and the review text stay as they
 * were. */
import type { ToolHandler } from "../ai/mermaid_loop.ts";
import type { Json } from "../types.ts";
import type { ResolvedFinding } from "../review/carry_over.ts";
import { type Companion, companionPath } from "../review/companions.ts";
import { SEARCH_NON_CODE } from "../tools/search_non_code.ts";
import { toolError } from "./codegraph_tool_args.ts";
import {
  READ_FULL_DIFF_TOOL,
  readFullDiff,
  type ReadableDiff,
} from "./diff_summary.ts";
import type { PlannedFile } from "./diff_plan.ts";

/** Searches one companion with the tool's own arguments, `repo` taken out.
 * Local review searches the checkout, a remote server asks the client. */
export type CompanionSearch = (
  repo: string,
  args: Record<string, unknown>,
) => Promise<string>;

/** The companions a review reads, as the engine takes them. */
export type ReviewCompanions = {
  list: Companion[];
  /** Left out, `search-non-code` keeps its own arguments. */
  search?: CompanionSearch;
};

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function withProperty(
  tool: Json,
  edit: (fn: Record<string, unknown>) => Record<string, unknown>,
): Json {
  const copy = structuredClone(tool) as { function: Record<string, unknown> };
  return { ...copy, function: edit(copy.function) };
}

/** `read-full-diff` for the reviewed files and every companion file. The
 * reviewed files keep the states the diff plan gave them. */
function companionDiffTool(
  planned: PlannedFile[],
  companions: Companion[],
  maxChars: number | null,
): ToolHandler {
  const readable = new Map<string, ReadableDiff>(
    planned.map((file) => [
      file.path,
      { state: file.state, patch: file.patch },
    ]),
  );
  for (const companion of companions) {
    for (const file of companion.files) {
      readable.set(companionPath(companion.repo, file.path), {
        state: "partial",
        patch: file.patch,
      });
    }
  }
  return {
    name: "read-full-diff",
    tool: withProperty(READ_FULL_DIFF_TOOL, (fn) => {
      const parameters = fn.parameters as {
        properties: Record<string, Record<string, unknown>>;
      };
      parameters.properties.path = {
        ...parameters.properties.path,
        description:
          "The file path exactly as it appears in this prompt's DIFF or PULL REQUEST section, or a companion file as owner/repo:path from a COMPANION block.",
      };
      return fn;
    }),
    run: (args: unknown) => readFullDiff(readable, args, maxChars),
  };
}

/** `search-non-code` with a `repo` argument: this repository by default, or
 * one companion. `onResult` sees what each companion search answered. */
export function companionSearchTool(
  base: ToolHandler,
  repo: string,
  companions: Companion[],
  search: CompanionSearch,
  onResult: (companion: Companion, output: string) => void = () => {},
): ToolHandler {
  const names = [repo, ...companions.map((companion) => companion.repo)];
  return {
    ...base,
    tool: withProperty(base.tool, (fn) => {
      const parameters = fn.parameters as {
        properties: Record<string, unknown>;
      };
      parameters.properties.repo = {
        type: "string",
        description: `The repository to search, as owner/repo: ${names.join(", ")}. This repository when left out. A companion is searched as its files are on disk.`,
      };
      return {
        ...fn,
        description: `${String(fn.description ?? "")} Pass repo to search a companion repository named in a COMPANION block.`,
      };
    }),
    run: async (args: unknown) => {
      const input = {
        ...((typeof args === "object" && args !== null ? args : {}) as Record<
          string,
          unknown
        >),
      };
      const asked = input.repo;
      delete input.repo;
      if (asked !== undefined && typeof asked !== "string") {
        return toolError("repo must be a string");
      }
      const name = asked?.trim() ?? "";
      if (name === "" || sameRepo(name, repo)) return await base.run(input);
      const companion = companions.find((item) => sameRepo(item.repo, name));
      if (!companion) {
        return toolError(
          `no repository ${name} in this review. Repositories you can search: ${names.join(", ")}`,
        );
      }
      const output = await search(companion.repo, input);
      onResult(companion, output);
      return output;
    },
  };
}

/** The review's tools with the companions' additions, and the private text
 * they make: every patch of a private companion and what a search of one
 * answered. */
export function withCompanionTools(
  tools: ToolHandler[],
  companions: ReviewCompanions | undefined,
  input: {
    repo: string;
    planned: PlannedFile[];
    readDiffMaxChars: number | null;
  },
): { tools: ToolHandler[]; privateResults: () => string[] } {
  const list = companions?.list ?? [];
  if (list.length === 0) return { tools, privateResults: () => [] };
  const found: string[] = [];
  const patches = list
    .filter((companion) => companion.private)
    .flatMap((companion) => companion.files.map((file) => file.patch))
    .filter(Boolean);
  const anyFile = list.some((companion) => companion.files.length > 0);
  const out = tools.map((tool) => {
    if (tool.name === SEARCH_NON_CODE && companions?.search) {
      return companionSearchTool(
        tool,
        input.repo,
        list,
        companions.search,
        (companion, output) => {
          if (companion.private) found.push(output);
        },
      );
    }
    if (tool.name === "read-full-diff" && anyFile) {
      return companionDiffTool(input.planned, list, input.readDiffMaxChars);
    }
    return tool;
  });
  if (anyFile && !out.some((tool) => tool.name === "read-full-diff")) {
    out.push(companionDiffTool(input.planned, list, input.readDiffMaxChars));
  }
  return { tools: out, privateResults: () => [...patches, ...found] };
}

const HEADING =
  /^###\s+\[(?<severity>P[0-3])\s*·\s*(?<impact>blocking|non-blocking)\]/;
const LOCATION = /^\s*Location\s*:\s*`?(.+?)`?\s*$/im;
const REFERENCES = /^\s*References\s*:\s*(.+?)\s*$/im;

/** One finding block placed on a companion file, as a finding with no
 * location, labeled with the companion's name. */
function companionFinding(
  block: string,
  repo: string,
  location: string,
): ResolvedFinding {
  const meta = HEADING.exec(block)?.groups;
  const severity = meta?.severity ?? "P2";
  const impact = meta?.impact ?? "non-blocking";
  const file = location.slice(repo.length + 1);
  const lines = block.split("\n").slice(1);
  const suggestion = lines.findIndex((line) => /^\s*Suggestion\s*:/.test(line));
  const body = (suggestion === -1 ? lines : lines.slice(0, suggestion))
    .filter((line) => !LOCATION.test(line) && !REFERENCES.test(line))
    .join("\n")
    .trim();
  const references = REFERENCES.exec(block)?.[1];
  return {
    id: crypto.randomUUID(),
    state: "new",
    path: null,
    lineFrom: null,
    lineTo: null,
    title: `[${severity} · ${impact}] \`${repo}\`: \`${file}\``,
    bodyMd: body,
    anchorText: null,
    severity,
    carriedFromId: null,
    firstSeenReviewId: null,
    referenceIds: references
      ? references
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : [],
  };
}

/** Takes every finding placed on a companion file out of the review text and
 * returns it as a finding without a location. The text keeps every other
 * finding and the previous findings section as they were. */
export function splitCompanionFindings(
  markdown: string,
  companions: Companion[] | undefined,
): { text: string; findings: ResolvedFinding[] } {
  const repos = (companions ?? []).map((companion) => companion.repo);
  if (repos.length === 0) return { text: markdown, findings: [] };
  const cut = markdown.search(/^## Previous findings\b/im);
  const head = cut === -1 ? markdown : markdown.slice(0, cut);
  const tail = cut === -1 ? "" : markdown.slice(cut);
  const kept: string[] = [];
  const findings: ResolvedFinding[] = [];
  let blocks = 0;
  for (const part of head.split(/(?=^###\s)/m)) {
    if (!/^###\s/.test(part)) {
      kept.push(part);
      continue;
    }
    const location = LOCATION.exec(part)?.[1]?.trim() ?? "";
    const repo = repos.find((name) =>
      location.toLowerCase().startsWith(`${name.toLowerCase()}:`),
    );
    if (!repo) {
      kept.push(part);
      blocks++;
      continue;
    }
    findings.push(companionFinding(part, repo, location));
  }
  if (findings.length === 0) return { text: markdown, findings };
  let text = kept.join("");
  if (blocks === 0) text = `${text.trimEnd()}\n\nNo actionable findings.\n`;
  if (tail) text = `${text.trimEnd()}\n\n${tail}`;
  return { text, findings };
}
