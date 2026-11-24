/** Matches known secret shapes, not a generic "long random string"
 * heuristic, too many false positives on commit SHAs and hashes. More
 * specific kinds come first. */
const SHAPES: { kind: string; source: string }[] = [
  // ghp_, gho_, ghu_, ghs_, ghr_ (classic GitHub PATs and tokens)
  { kind: "github-token", source: String.raw`gh[pousr]_[A-Za-z0-9]{20,}` },
  { kind: "github-token", source: String.raw`github_pat_[A-Za-z0-9_]{20,}` },
  { kind: "openrouter-key", source: String.raw`sk-or-[A-Za-z0-9-]{10,}` },
  { kind: "anthropic-key", source: String.raw`sk-ant-[A-Za-z0-9_-]{10,}` },
  { kind: "stripe-key", source: String.raw`(?:sk|rk)_live_[A-Za-z0-9]{16,}` },
  // OpenAI keys, old `sk-` and new `sk-proj-` alike
  { kind: "openai-key", source: String.raw`sk-[A-Za-z0-9_-]{20,}` },
  // remote review bearer tokens
  { kind: "co-maintainer-token", source: String.raw`cmr_[A-Za-z0-9_-]{20,}` },
  {
    kind: "aws-access-key",
    source: String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])`,
  },
  { kind: "slack-token", source: String.raw`xox[abeprs]-[A-Za-z0-9-]{10,}` },
  { kind: "google-key", source: String.raw`AIza[A-Za-z0-9_-]{35}` },
  { kind: "gitlab-token", source: String.raw`glpat-[A-Za-z0-9_-]{20,}` },
  { kind: "npm-token", source: String.raw`npm_[A-Za-z0-9]{36}` },
];

/** For the model, each prefix must start a word, so an identifier such as
 * `mask-radial-farthest-side` reaches it whole. Output redaction keeps
 * cutting any match, a stray cut there costs nothing. */
const WORD_START = "(?<![A-Za-z0-9])";
const SECRETS = SHAPES.map(({ kind, source }) => ({
  kind,
  pattern: new RegExp(`${WORD_START}${source}`, "g"),
}));
const OUTPUT_SECRETS = SHAPES.map(({ source }) => new RegExp(source, "g"));

/** Secrets that need the text around them: only the value is masked. */
const VALUES: { kind: string; pattern: RegExp }[] = [
  {
    kind: "aws-secret-key",
    pattern:
      /(aws_secret_access_key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})/gi,
  },
  // scheme://user:PASSWORD@host
  {
    kind: "url-password",
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(?=@)/gi,
  },
  // A JWT's signature. The header and claims stay readable.
  {
    kind: "jwt-signature",
    pattern:
      /(\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.)([A-Za-z0-9_-]{16,})/g,
  },
];

const PEM_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** For output: posted text, stored findings, logs. */
export function redact(text: string): string {
  let result = text.replace(PEM_BLOCK, "[redacted]");
  for (const pattern of OUTPUT_SECRETS) {
    result = result.replace(pattern, "[redacted]");
  }
  for (const { pattern } of VALUES) {
    result = result.replace(
      pattern,
      (_all, before: string) => `${before}[redacted]`,
    );
  }
  return result;
}

export const SECRET_MASK = /\[redacted:[a-z-]+\]/;

/** For input to the model: each known secret becomes `[redacted:<kind>]`, so
 * the model can still say a key is committed without seeing it. Lines are
 * kept, so line numbers in a diff stay true. A private key keeps its BEGIN
 * and END lines and loses its body, also when a cut removed the END line.
 * Running it twice changes nothing. */
export function maskSecrets(text: string): {
  text: string;
  count: number;
  values: string[];
} {
  const seen = new Set<string>();
  const mask = (kind: string, value: string) => {
    seen.add(value);
    return `[redacted:${kind}]`;
  };
  let result = text.replace(
    /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    (all, begin: string, body: string, end: string) => {
      if (!/[A-Za-z0-9+/]{16,}/.test(body)) return all;
      // One key, however many lines its body has.
      seen.add(body);
      const masked = body.replace(
        // A run never starts with `+`, so a diff line keeps its marker.
        /(?<![A-Za-z0-9/=])[A-Za-z0-9/][A-Za-z0-9+/=]{15,}/g,
        "[redacted:private-key]",
      );
      return `${begin}${masked}${end}`;
    },
  );
  for (const { kind, pattern } of SECRETS) {
    result = result.replace(pattern, (value) => mask(kind, value));
  }
  for (const { kind, pattern } of VALUES) {
    result = result.replace(
      pattern,
      (_all, before: string, value: string) => `${before}${mask(kind, value)}`,
    );
  }
  return { text: result, count: seen.size, values: [...seen] };
}

export function hasSecretMask(text: string): boolean {
  return SECRET_MASK.test(text);
}

/** Fenced blocks and inline code spans. The capture group puts code on odd
 * split indices, so prose can be cleaned without rewriting the code. */
const CODE = /(````[\s\S]*?````|```[\s\S]*?```|`[^`\n]*`)/;

export function outsideCode(
  text: string,
  clean: (prose: string) => string,
): string {
  return text
    .split(CODE)
    .map((part, index) => (index % 2 === 1 ? part : clean(part)))
    .join("");
}

/** Dashboard and other human-readable copy. Secrets out, no dash, no
 * semicolon. Code keeps its own punctuation or it stops compiling. */
export function safeCopy(text: string): string {
  // punctuation: code, this cleaner must name the semicolon it removes from AI text
  return outsideCode(redact(text), (prose) =>
    prose.replace(/[ \t]*\u2014[ \t]*/g, ", ").replaceAll(";", "."),
  );
}
