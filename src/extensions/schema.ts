/** The JSON an extension prints on stdout, as data.
 *
 * One list of field specs drives two things: the validator that decides
 * whether a response is usable, and the schema table in the extensions docs
 * page. A field cannot be checked one way and documented another, and the docs
 * test fails when the table on the page is older than this list. The rules
 * that tie one field to another (a verdict only with `ok`, a reason with
 * `skipped`) are written out in `crossFieldProblem` and named in the table's
 * rule column. */

export const EXTENSION_SCHEMA_VERSION = 1;

/** The longest wait a `retry` response may ask for. */
export const MAX_RETRY_AFTER_SECONDS = 180;

/** Limits that keep one response from filling app.db, the dashboard and a
 * remote client's output. */
const MAX_TITLE_CHARS = 500;
const MAX_BODY_CHARS = 20_000;
const MAX_KEY_CHARS = 200;
const MAX_LABEL_CHARS = 100;
const MAX_PATH_CHARS = 1_000;
const MAX_REASON_CHARS = 2_000;
export const MAX_MARKDOWN_CHARS = 200_000;
/** A cost or a token count past these is a bug, not a bill. */
const MAX_COST_USD = 10_000;
const MAX_TOKENS = 10_000_000_000;

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export const STATUSES = ["ok", "failed", "skipped", "retry"] as const;
export const VERDICTS = ["request_changes", "comment"] as const;
export const MEDIA_KINDS = ["image", "video", "link"] as const;

export type ExtensionStatus = (typeof STATUSES)[number];
export type ExtensionVerdict = (typeof VERDICTS)[number];
export type Severity = (typeof SEVERITIES)[number];

export type ExtensionFindingInput = {
  key?: string;
  severity: Severity;
  blocking: boolean;
  title: string;
  body: string;
  path?: string;
  lineFrom?: number;
  lineTo?: number;
};

export type ExtensionMedia = {
  kind: (typeof MEDIA_KINDS)[number];
  label: string;
  url: string;
};

export type ExtensionMetric = { name: string; value: number; unit?: string };

export type ExtensionData = {
  media: ExtensionMedia[];
  metrics: ExtensionMetric[];
};

export type ExtensionUsage = {
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  cachedIn?: number;
  cachedOut?: number;
};

/** A response after validation, with every optional list filled in. */
export type ExtensionResponse = {
  schemaVersion: number;
  name: string;
  status: ExtensionStatus;
  verdict?: ExtensionVerdict;
  reason?: string;
  retryAfterSeconds?: number;
  markdown: string;
  findings: ExtensionFindingInput[];
  data: ExtensionData;
  extraData: unknown;
  usage?: ExtensionUsage;
};

type FieldType =
  | "string"
  | "url"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "any";

export type FieldSpec = {
  name: string;
  type: FieldType;
  /** `yes`, `no`, or the rule that decides it, as the docs table prints it. */
  required: string;
  enum?: readonly string[];
  min?: number;
  /** For a string, its longest length in characters. */
  maxLength?: number;
  max?: number;
  /** The fields of an object, or of each object in an array. */
  fields?: FieldSpec[];
  description: string;
};

export const RESPONSE_FIELDS: FieldSpec[] = [
  {
    name: "schemaVersion",
    type: "integer",
    required: "yes",
    description: `Must be ${EXTENSION_SCHEMA_VERSION}. Any other value is Failed, with that as the reason.`,
  },
  {
    name: "name",
    type: "string",
    maxLength: MAX_LABEL_CHARS,
    required: "yes",
    description: "The extension's own name, for its logs.",
  },
  {
    name: "status",
    type: "string",
    required: "yes",
    enum: STATUSES,
    description: "How the run ended.",
  },
  {
    name: "verdict",
    type: "string",
    required: "with `ok`, absent otherwise",
    enum: VERDICTS,
    description:
      "`request_changes` makes the whole review Request changes. It always wins over a finding's `blocking`.",
  },
  {
    name: "reason",
    type: "string",
    maxLength: MAX_REASON_CHARS,
    required: "with `skipped` and `retry`",
    description: "Why the extension skipped, failed or wants a retry.",
  },
  {
    name: "retryAfterSeconds",
    type: "integer",
    required: "with `retry`",
    min: 0,
    max: MAX_RETRY_AFTER_SECONDS,
    description: "How long to wait before the next run.",
  },
  {
    name: "markdown",
    type: "string",
    maxLength: MAX_MARKDOWN_CHARS,
    required: "no",
    description:
      "Shown in the GitHub review and the job summary, inside a `<details>` block named after the extension.",
  },
  {
    name: "findings",
    type: "array",
    required: "no",
    description: "Findings that join the review.",
    fields: [
      {
        name: "key",
        type: "string",
        maxLength: MAX_KEY_CHARS,
        required: "no",
        description:
          "A stable id. With one, the finding is tracked across rounds: seen again means still open, missing means closed.",
      },
      {
        name: "severity",
        type: "string",
        required: "yes",
        enum: SEVERITIES,
        description: "P0 is the most severe.",
      },
      {
        name: "blocking",
        type: "boolean",
        required: "yes",
        description: "Whether this finding alone should block the merge.",
      },
      {
        name: "title",
        type: "string",
        maxLength: MAX_TITLE_CHARS,
        required: "yes",
        description: "One line.",
      },
      {
        name: "body",
        type: "string",
        maxLength: MAX_BODY_CHARS,
        required: "yes",
        description: "The explanation, in Markdown.",
      },
      {
        name: "path",
        type: "string",
        maxLength: MAX_PATH_CHARS,
        required: "no",
        description: "A file path relative to the repository root.",
      },
      {
        name: "lineFrom",
        type: "integer",
        required: "no",
        min: 1,
        description: "First line in the new file.",
      },
      {
        name: "lineTo",
        type: "integer",
        required: "no",
        min: 1,
        description: "Last line in the new file.",
      },
    ],
  },
  {
    name: "data",
    type: "object",
    required: "no",
    description: "Results with a fixed shape co-maintainer can show.",
    fields: [
      {
        name: "media",
        type: "array",
        required: "no",
        description:
          "Files the extension uploaded itself. co-maintainer uploads nothing.",
        fields: [
          {
            name: "kind",
            type: "string",
            required: "yes",
            enum: MEDIA_KINDS,
            description: "What the URL points at.",
          },
          {
            name: "label",
            type: "string",
            maxLength: MAX_LABEL_CHARS,
            required: "yes",
            description: "A short name, such as `main` or `pr`.",
          },
          {
            name: "url",
            type: "url",
            required: "yes",
            description: "An http or https URL.",
          },
        ],
      },
      {
        name: "metrics",
        type: "array",
        required: "no",
        description: "Numbers worth showing next to the result.",
        fields: [
          {
            name: "name",
            type: "string",
            required: "yes",
            description: "What was measured.",
          },
          {
            name: "value",
            type: "number",
            required: "yes",
            description: "The measurement.",
          },
          {
            name: "unit",
            type: "string",
            required: "no",
            description: "Such as `ms` or `MB`.",
          },
        ],
      },
    ],
  },
  {
    name: "extraData",
    type: "any",
    required: "no",
    description:
      "Free-form. Passed through to `--json` and never read by co-maintainer.",
  },
  {
    name: "usage",
    type: "object",
    required: "no",
    description: "What the run cost, when it used AI.",
    fields: [
      {
        name: "costUsd",
        type: "number",
        required: "no",
        min: 0,
        max: MAX_COST_USD,
        description: "Joins the review's total cost.",
      },
      {
        name: "tokensIn",
        type: "integer",
        required: "no",
        min: 0,
        max: MAX_TOKENS,
        description: "Input tokens.",
      },
      {
        name: "tokensOut",
        type: "integer",
        required: "no",
        min: 0,
        max: MAX_TOKENS,
        description: "Output tokens.",
      },
      {
        name: "cachedIn",
        type: "integer",
        required: "no",
        min: 0,
        max: MAX_TOKENS,
        description: "Cached input tokens.",
      },
      {
        name: "cachedOut",
        type: "integer",
        required: "no",
        min: 0,
        max: MAX_TOKENS,
        description: "Cached output tokens.",
      },
    ],
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeProblem(spec: FieldSpec, value: unknown): string | undefined {
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") return "must be a string";
      break;
    case "url": {
      if (typeof value !== "string") return "must be a string";
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return "must be an http or https URL";
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "must be an http or https URL";
      }
      break;
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return "must be a number";
      }
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return "must be an integer";
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") return "must be true or false";
      break;
    case "object":
      if (!isRecord(value)) return "must be an object";
      break;
    case "array":
      if (!Array.isArray(value)) return "must be an array";
      break;
    case "any":
      break;
  }
  if (
    spec.maxLength !== undefined &&
    typeof value === "string" &&
    value.length > spec.maxLength
  ) {
    return `must be at most ${spec.maxLength} characters`;
  }
  if (spec.enum && !spec.enum.includes(value as string)) {
    return `must be one of ${spec.enum.join(", ")}`;
  }
  if (typeof value === "number") {
    if (spec.min !== undefined && value < spec.min) {
      return `must be at least ${spec.min}`;
    }
    if (spec.max !== undefined && value > spec.max) {
      return `must be at most ${spec.max}`;
    }
  }
  return undefined;
}

/** The first problem in `value` against `fields`, as `path message`. Unknown
 * fields are ignored, so an extension may add its own. */
function fieldsProblem(
  fields: FieldSpec[],
  value: Record<string, unknown>,
  prefix: string,
): string | undefined {
  for (const spec of fields) {
    const path = `${prefix}${spec.name}`;
    const item = value[spec.name];
    if (item === undefined || item === null) {
      if (spec.required === "yes") return `${path} is required`;
      continue;
    }
    const problem = typeProblem(spec, item);
    if (problem) return `${path} ${problem}`;
    if (!spec.fields) continue;
    if (spec.type === "object") {
      const nested = fieldsProblem(
        spec.fields,
        item as Record<string, unknown>,
        `${path}.`,
      );
      if (nested) return nested;
    }
    if (spec.type === "array") {
      const list = item as unknown[];
      for (let index = 0; index < list.length; index++) {
        const entry = list[index];
        if (!isRecord(entry)) return `${path}[${index}] must be an object`;
        const nested = fieldsProblem(spec.fields, entry, `${path}[${index}].`);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

/** The rules the field list cannot say on its own. */
function crossFieldProblem(value: Record<string, unknown>): string | undefined {
  const status = value.status as ExtensionStatus;
  const hasVerdict = value.verdict !== undefined && value.verdict !== null;
  if (status === "ok" && !hasVerdict) return "verdict is required with ok";
  if (status !== "ok" && hasVerdict) {
    return `verdict must be absent with ${status}`;
  }
  const hasReason = typeof value.reason === "string" && value.reason !== "";
  if ((status === "skipped" || status === "retry") && !hasReason) {
    return `reason is required with ${status}`;
  }
  if (status === "retry" && typeof value.retryAfterSeconds !== "number") {
    return "retryAfterSeconds is required with retry";
  }
  const findings = (value.findings ?? []) as Record<string, unknown>[];
  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index]!;
    const from = finding.lineFrom as number | undefined;
    const to = finding.lineTo as number | undefined;
    if (to !== undefined && from === undefined) {
      return `findings[${index}].lineTo needs lineFrom`;
    }
    if (from !== undefined && to !== undefined && to < from) {
      return `findings[${index}].lineTo must not be before lineFrom`;
    }
    if (from !== undefined && typeof finding.path !== "string") {
      return `findings[${index}].lineFrom needs path`;
    }
  }
  return undefined;
}

export type ValidationResult =
  | { ok: true; response: ExtensionResponse }
  | { ok: false; reason: string };

/** Checks one parsed response. An unsupported `schemaVersion` is reported on
 * its own, before anything else, so an extension built for a later version
 * gets a reason that says so instead of a complaint about a field it renamed. */
export function validateResponse(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return { ok: false, reason: "the response is not a JSON object" };
  }
  if (
    value.schemaVersion !== undefined &&
    value.schemaVersion !== EXTENSION_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      reason: `unsupported schemaVersion ${JSON.stringify(value.schemaVersion)}, this co-maintainer reads ${EXTENSION_SCHEMA_VERSION}`,
    };
  }
  const problem =
    fieldsProblem(RESPONSE_FIELDS, value, "") ?? crossFieldProblem(value);
  if (problem) return { ok: false, reason: problem };
  const data = (value.data ?? {}) as Record<string, unknown>;
  const response: ExtensionResponse = {
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    name: value.name as string,
    status: value.status as ExtensionStatus,
    markdown: typeof value.markdown === "string" ? value.markdown : "",
    findings: ((value.findings ?? []) as Record<string, unknown>[]).map(
      (finding) => ({
        ...(typeof finding.key === "string" && finding.key !== ""
          ? { key: finding.key }
          : {}),
        severity: finding.severity as Severity,
        blocking: finding.blocking as boolean,
        title: finding.title as string,
        body: finding.body as string,
        ...(typeof finding.path === "string" ? { path: finding.path } : {}),
        ...(typeof finding.lineFrom === "number"
          ? { lineFrom: finding.lineFrom }
          : {}),
        ...(typeof finding.lineTo === "number"
          ? { lineTo: finding.lineTo }
          : {}),
      }),
    ),
    data: {
      media: ((data.media ?? []) as ExtensionMedia[]).map((media) => ({
        kind: media.kind,
        label: media.label,
        url: media.url,
      })),
      metrics: ((data.metrics ?? []) as ExtensionMetric[]).map((metric) => ({
        name: metric.name,
        value: metric.value,
        ...(typeof metric.unit === "string" ? { unit: metric.unit } : {}),
      })),
    },
    extraData: value.extraData ?? null,
  };
  if (value.verdict !== undefined && value.verdict !== null) {
    response.verdict = value.verdict as ExtensionVerdict;
  }
  if (typeof value.reason === "string" && value.reason !== "") {
    response.reason = value.reason;
  }
  if (typeof value.retryAfterSeconds === "number") {
    response.retryAfterSeconds = value.retryAfterSeconds;
  }
  if (isRecord(value.usage)) {
    const usage: ExtensionUsage = {};
    for (const field of [
      "costUsd",
      "tokensIn",
      "tokensOut",
      "cachedIn",
      "cachedOut",
    ] as const) {
      const number = value.usage[field];
      if (typeof number === "number") usage[field] = number;
    }
    response.usage = usage;
  }
  return { ok: true, response };
}

/** stdout as a response. Only the whole of stdout counts: no streaming, no
 * log lines around the JSON. */
export function parseResponse(stdout: string): ValidationResult {
  const text = stdout.trim();
  if (text === "") return { ok: false, reason: "the command printed nothing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "stdout is not one JSON document" };
  }
  return validateResponse(parsed);
}

/** A table cell: no raw pipe, which would split the column. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function typeLabel(spec: FieldSpec): string {
  if (spec.enum) return spec.enum.map((value) => `\`${value}\``).join(", ");
  if (spec.type === "array" && spec.fields) return "array of objects";
  if (spec.type === "url") return "string (URL)";
  return spec.type;
}

function tableRows(fields: FieldSpec[], prefix: string, rows: string[]): void {
  for (const spec of fields) {
    const path = `${prefix}${spec.name}`;
    const limits: string[] = [];
    if (spec.min !== undefined) limits.push(`min ${spec.min}`);
    if (spec.max !== undefined) limits.push(`max ${spec.max}`);
    if (spec.maxLength !== undefined) {
      limits.push(`at most ${spec.maxLength} characters`);
    }
    const description = limits.length
      ? `${spec.description} (${limits.join(", ")})`
      : spec.description;
    rows.push(
      `| \`${path}\` | ${cell(typeLabel(spec))} | ${cell(spec.required)} | ${cell(description)} |`,
    );
    if (spec.fields) {
      tableRows(
        spec.fields,
        spec.type === "array" ? `${path}[].` : `${path}.`,
        rows,
      );
    }
  }
}

/** The response schema as the Markdown table the docs page carries between
 * its `extension-schema` markers. */
export function responseSchemaTable(): string {
  const rows = ["| Field | Type | Required | Meaning |", "|---|---|---|---|"];
  tableRows(RESPONSE_FIELDS, "", rows);
  return rows.join("\n");
}

export const SCHEMA_BLOCK_START = "<!-- extension-schema:start -->";
export const SCHEMA_BLOCK_END = "<!-- extension-schema:end -->";

/** Rewrites the schema block in a docs page from the code. */
export function applySchemaBlock(md: string): string {
  const start = md.indexOf(SCHEMA_BLOCK_START);
  const end = md.indexOf(SCHEMA_BLOCK_END);
  if (start === -1 || end === -1 || end < start) return md;
  return (
    md.slice(0, start) +
    `${SCHEMA_BLOCK_START}\n${responseSchemaTable()}\n${SCHEMA_BLOCK_END}` +
    md.slice(end + SCHEMA_BLOCK_END.length)
  );
}
