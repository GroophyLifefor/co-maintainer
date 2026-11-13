/** The diagram runtime: which diagram language a review asks the model for
 * and what happens to the source it gets back.
 *
 * `mermaid` is the original behavior and owns none of its wording here, the
 * Mermaid prompts and tool stay in `pr/reviewer.ts` and `ai/mermaid.ts`.
 * `plantuml` asks for standard PlantUML and keeps the fenced source as the
 * model wrote it. `plantuml-server` asks the same way, then turns every
 * PlantUML block into an image link on a PlantUML server. This module only
 * builds that URL. It never makes a request, so a server that is down or
 * slow is the reader's browser's problem, not a review failure. */
import { deflateRawSync } from "node:zlib";
import type { RepoConfig } from "../config.ts";
import type { Options } from "../types.ts";
import { log } from "../util/log.ts";
import { redact } from "../util/redact.ts";

export const DIAGRAM_RUNTIMES = [
  "mermaid",
  "plantuml",
  "plantuml-server",
] as const;
export type DiagramRuntime = (typeof DIAGRAM_RUNTIMES)[number];

export const PLANTUML_FORMATS = ["svg", "png"] as const;
export type PlantumlFormat = (typeof PLANTUML_FORMATS)[number];

export const DEFAULT_DIAGRAM_RUNTIME: DiagramRuntime = "mermaid";
export const DEFAULT_PLANTUML_SERVER = "https://www.plantuml.com";
export const DEFAULT_PLANTUML_FORMAT: PlantumlFormat = "svg";

/** The three fields as `Options` and `RepoConfig` carry them. */
export type DiagramOptions = Pick<
  Options,
  "diagramRuntime" | "plantumlServer" | "plantumlOutputFormat"
>;

export type DiagramSettings = {
  runtime: DiagramRuntime;
  server: string;
  format: PlantumlFormat;
};

/** A bad diagram setting. Callers that talk to a person turn it into a usage
 * error. A background job lets it fail the job with this message. */
export class DiagramSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagramSettingError";
  }
}

/** What is wrong with a runtime name, or `null` when it is fine. */
export function diagramRuntimeProblem(value: string): string | null {
  return (DIAGRAM_RUNTIMES as readonly string[]).includes(value)
    ? null
    : `must be one of: ${DIAGRAM_RUNTIMES.join(", ")}`;
}

export function plantumlFormatProblem(value: string): string | null {
  return (PLANTUML_FORMATS as readonly string[]).includes(value)
    ? null
    : `must be one of: ${PLANTUML_FORMATS.join(", ")}`;
}

/** A server must be an http or https URL. Credentials, a query string and a
 * fragment are refused because the diagram path is appended to the end and
 * nothing after it would survive. */
export function plantumlServerProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an http or https URL such as https://www.plantuml.com";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "must be an http or https URL such as https://www.plantuml.com";
  }
  if (url.username || url.password) {
    return "must not contain a user name or password";
  }
  if (url.search || url.hash) {
    return "must not contain a query string or a fragment";
  }
  // The link is posted as Markdown, so a path that can end it early or be
  // rewritten as prose would break every diagram.
  if (/\s/.test(value) || /[()[\]<>`\\;"]/.test(url.pathname)) {
    return 'must not contain spaces or any of ( ) [ ] < > ` \\ ; " in its path';
  }
  return null;
}

/** Reads the three settings. A flag wins over the repository's stored value.
 * Only fields that were actually given come back, so a repository that sets
 * nothing keeps the exact `Options` it always had. Every given value is
 * checked, even one the chosen runtime ignores, so a typo never hides. */
export function diagramOptionsFrom(
  flags: { runtime?: string; server?: string; format?: string },
  stored: Pick<
    RepoConfig,
    "diagramRuntime" | "plantumlServer" | "plantumlOutputFormat"
  > = {},
  repo?: string,
): DiagramOptions {
  const where = repo ? `config.json repos[${repo}].` : "config.json ";
  const pick = (
    flag: string | undefined,
    flagName: string,
    kept: string | undefined,
    keptName: string,
    problemOf: (value: string) => string | null,
  ): string | undefined => {
    if (flag !== undefined) {
      const problem = problemOf(flag);
      if (problem) throw new DiagramSettingError(`${flagName} ${problem}`);
      return flag;
    }
    if (kept !== undefined) {
      const problem = problemOf(kept);
      if (problem)
        throw new DiagramSettingError(`${where}${keptName} ${problem}`);
      return kept;
    }
    return undefined;
  };
  const runtime = pick(
    flags.runtime,
    "--diagram-runtime",
    stored.diagramRuntime,
    "diagramRuntime",
    diagramRuntimeProblem,
  );
  const server = pick(
    flags.server,
    "--plantuml-server",
    stored.plantumlServer,
    "plantumlServer",
    plantumlServerProblem,
  );
  const format = pick(
    flags.format,
    "--plantuml-output-format",
    stored.plantumlOutputFormat,
    "plantumlOutputFormat",
    plantumlFormatProblem,
  );
  return {
    ...(runtime ? { diagramRuntime: runtime as DiagramRuntime } : {}),
    ...(server ? { plantumlServer: server } : {}),
    ...(format ? { plantumlOutputFormat: format as PlantumlFormat } : {}),
  };
}

/** The repository's stored settings for a background job. A bad stored value
 * is not allowed to stop the job, because nobody is at a terminal to read the
 * error and the pull request would get no trace. The job falls back to
 * `mermaid`, which sends nothing anywhere, and says so once through `warn`.
 * The fallback is never a lone default for one field, since a good
 * `plantuml-server` runtime next to a bad server must not send the diagram
 * source to a server the owner did not choose. */
export function serverDiagramOptions(
  stored: Pick<
    RepoConfig,
    "diagramRuntime" | "plantumlServer" | "plantumlOutputFormat"
  >,
  repo: string,
  warn: (message: string) => void = (message) => log("diagram", message),
): DiagramOptions {
  try {
    return diagramOptionsFrom({}, stored, repo);
  } catch (error) {
    if (!(error instanceof DiagramSettingError)) throw error;
    warn(
      `${error.message}. The diagram settings are ignored and this job uses mermaid.`,
    );
    return {};
  }
}

/** The settings with their defaults filled in. */
export function diagramSettings(
  options: Partial<DiagramOptions> | undefined,
): DiagramSettings {
  return {
    runtime: options?.diagramRuntime ?? DEFAULT_DIAGRAM_RUNTIME,
    server: options?.plantumlServer ?? DEFAULT_PLANTUML_SERVER,
    format: options?.plantumlOutputFormat ?? DEFAULT_PLANTUML_FORMAT,
  };
}

function isPlantuml(options: Partial<DiagramOptions> | undefined): boolean {
  return diagramSettings(options).runtime !== "mermaid";
}

/** The request field that leaves the Mermaid syntax tool out. A PlantUML
 * runtime needs no syntax lookup, so the tool is not offered to a model that
 * will not use it. Mermaid adds nothing, so its request is unchanged. */
export function mermaidToolFields(
  options: Partial<DiagramOptions> | undefined,
): { withoutMermaidTool?: true } {
  return isPlantuml(options) ? { withoutMermaidTool: true } : {};
}

// PlantUML's own base64: the usual 6 bit groups, a different alphabet.
const PLANTUML_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

/** The PlantUML text encoding: the UTF-8 source, raw deflate, then the
 * PlantUML base64. Any PlantUML server decodes it from the URL path. */
export function encodePlantuml(source: string): string {
  const bytes = deflateRawSync(Buffer.from(source, "utf8"), { level: 9 });
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i]!;
    const b2 = bytes[i + 1] ?? 0;
    const b3 = bytes[i + 2] ?? 0;
    out += PLANTUML_ALPHABET[b1 >> 2]!;
    out += PLANTUML_ALPHABET[((b1 & 0x3) << 4) | (b2 >> 4)]!;
    out += PLANTUML_ALPHABET[((b2 & 0xf) << 2) | (b3 >> 6)]!;
    out += PLANTUML_ALPHABET[b3 & 0x3f]!;
  }
  return out;
}

/** The public server answers under `/plantuml`. A server the user runs is
 * addressed exactly as given, because a self-hosted one is often served from
 * the root and the path is theirs to choose. */
function serverBase(server: string): string {
  const url = new URL(server);
  const path = url.pathname.replace(/\/+$/, "");
  // The public server under any scheme and with or without `www`.
  const isPublic = /^(www\.)?plantuml\.com$/.test(url.hostname);
  return `${url.origin}${path === "" && isPublic ? "/plantuml" : path}`;
}

/** The image URL for one diagram. Source without `@startuml` is wrapped, so a
 * model that forgot the markers still gets a diagram. */
export function plantumlImageUrl(
  source: string,
  server: string,
  format: PlantumlFormat,
  padding = 0,
): string {
  const text = /^\s*@start/m.test(source)
    ? source
    : `@startuml\n${source}\n@enduml`;
  // PlantUML ignores whatever follows the last @enduml, so blank lines there
  // change the encoded bytes and nothing else.
  return `${serverBase(server)}/${format}/${encodePlantuml(text + "\n".repeat(padding))}`;
}

/** The link for one diagram, or `undefined` when it cannot be a safe link.
 *
 * The source is redacted first. Once it is deflated and base64 encoded the
 * redactor that cleans review text can no longer see a token inside it, and
 * the link would carry the token to the pull request and to the PlantUML
 * server. After that the encoded text, which is base64, now and then spells
 * something that looks like an API key, and the redactor would cut the link.
 * Such a link is encoded again with blank lines after `@enduml`. The source
 * stays the redacted one on every try, so this can only get around a false
 * match on the encoding and never lets a real secret through. */
function imageUrlFor(
  rawSource: string,
  settings: DiagramSettings,
): string | undefined {
  const source = redact(rawSource);
  for (let padding = 0; padding < 16; padding++) {
    const url = plantumlImageUrl(
      source,
      settings.server,
      settings.format,
      padding,
    );
    if (url.length > MAX_IMAGE_URL_CHARS) return undefined;
    if (redact(url) === url) return url;
  }
  return undefined;
}

/** Past this a URL risks a server or proxy refusing it, so the block keeps its
 * source rather than becoming a broken image. */
const MAX_IMAGE_URL_CHARS = 7500;

const ANY_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const PLANTUML_TAG = /^[ \t]*(plantuml|puml)\b/i;

/** With `plantuml-server`, replaces every fenced PlantUML block by an image
 * link to the configured server. Any other runtime is returned untouched.
 * Every fence is walked the way Markdown reads it, so a PlantUML block inside
 * another fence (a suggestion, or a longer fence that quotes an example) is
 * content of that fence and stays as written. So does a block that is never
 * closed, and a block whose link would be too long. */
export function renderDiagrams(
  markdown: string,
  options: Partial<DiagramOptions> | undefined,
): string {
  const settings = diagramSettings(options);
  if (settings.runtime !== "plantuml-server") return markdown;
  const lines = markdown.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const open = ANY_FENCE.exec(line.replace(/\r$/, ""));
    // A backtick fence's info text cannot hold a backtick, so a line like
    // ```code``` is inline code and not a fence.
    if (!open || (open[2]![0] === "`" && open[3]!.includes("`"))) {
      out.push(line);
      continue;
    }
    const fence = open[2]!;
    const close = new RegExp(
      `^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*\\r?$`,
    );
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (close.test(lines[j]!)) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      // Never closed: the rest of the text belongs to this fence.
      out.push(...lines.slice(i));
      break;
    }
    const source = PLANTUML_TAG.test(open[3]!)
      ? lines
          .slice(i + 1, end)
          .join("\n")
          .replace(/\r/g, "")
          .trim()
      : "";
    const url = source ? imageUrlFor(source, settings) : undefined;
    if (!url) {
      out.push(...lines.slice(i, end + 1));
    } else {
      out.push(`${open[1]}![PlantUML diagram](${url})`);
    }
    i = end;
  }
  return out.join("\n");
}

const PLANTUML_GUIDANCE = `PlantUML selection and minimal syntax:
Write standard PlantUML source in a fenced code block tagged plantuml, from
@startuml to @enduml. Do not write an image, an image link, a server URL, or
any other diagram language. Our code decides how the source is shown.
sequence diagram = ordered calls, webhooks, retries, responses, and timing;
activity diagram = decisions, branches, pipelines, and fallback paths;
class diagram = classes, interfaces, types, inheritance, composition, and
database entities;
state diagram = lifecycle and state transitions;
component diagram = services, modules, boundaries, and integrations;
deployment diagram = containers, storage, and deployment topology;
use case diagram = actors and system capabilities.
Use the smallest type that matches the evidence. Keep labels short.`;

/** The system prompt's diagram section for a PlantUML runtime, or `undefined`
 * for Mermaid so the caller keeps its own text. */
export function plantumlSystemRules(
  options: Partial<DiagramOptions> | undefined,
): string | undefined {
  if (!isPlantuml(options)) return undefined;
  return `People generally find it easier to understand the
problem you've identified when it's presented in diagrams. When a multi-step
flow, lifecycle, dependency, data model, protocol, or architecture change is
part of the finding, you are expected to draw it. During the initial review, use
at most one diagram, so spend it on the finding that benefits most. If a user
later asks for detailed reasoning in a reply, that reply may use up to five
diagrams, but only when each adds a distinct useful view.
${PLANTUML_GUIDANCE}
Do not invent nodes, actors, states, services, tables, or events. Omit the
diagram only when no finding actually fits one of the categories above, or
when the syntax is genuinely uncertain.`;
}

/** The review prompt's diagram section for a PlantUML runtime. */
export function plantumlPromptRules(
  options: Partial<DiagramOptions> | undefined,
): string | undefined {
  if (!isPlantuml(options)) return undefined;
  return `People generally find it easier to understand the
problem you've identified when it's presented in diagrams. When a finding
involves a multi-step flow, lifecycle, dependency, data model, protocol, or
architecture change, you are expected to include a PlantUML fenced code block
for it, written as standard PlantUML between @startuml and @enduml. This review
may contain at most one diagram in total, so if more than one finding
qualifies, pick the one the diagram clarifies most. Its type must be one of the
types named in the system instructions. Keep labels short and grounded in the
supplied evidence. A one-line fix or an obvious, single-step cause and effect
genuinely needs no diagram. That is the only reason to omit one. Close every
fenced block.`;
}

/** The diagram sentences of a reply's system prompt for a PlantUML runtime. */
export function plantumlReplyRules(
  options: Partial<DiagramOptions> | undefined,
): string | undefined {
  if (!isPlantuml(options)) return undefined;
  return (
    "Use zero PlantUML diagrams when prose is clearer. For a detailed " +
    "reply, use at most five PlantUML diagrams, and only when each adds " +
    "a distinct useful view. " +
    PLANTUML_GUIDANCE +
    " Use only evidence-grounded syntax. Close every fenced code " +
    "block, and drop a planned diagram rather than letting the answer " +
    "run long."
  );
}
