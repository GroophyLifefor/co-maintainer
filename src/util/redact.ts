/** Matches known secret shapes, not a generic "long random string"
 * heuristic, too many false positives on commit SHAs and hashes. Each
 * prefix must start a word, so `mask-radial-farthest-side` is not an
 * OpenAI key. More specific kinds come first. */
const B = "(?<![A-Za-z0-9])";
const SECRETS: { kind: string; pattern: RegExp }[] = [
  // ghp_, gho_, ghu_, ghs_, ghr_ (classic GitHub PATs and tokens)
  {
    kind: "github-token",
    pattern: new RegExp(`${B}gh[pousr]_[A-Za-z0-9]{20,}`, "g"),
  },
  {
    kind: "github-token",
    pattern: new RegExp(`${B}github_pat_[A-Za-z0-9_]{20,}`, "g"),
  },
  {
    kind: "openrouter-key",
    pattern: new RegExp(`${B}sk-or-[A-Za-z0-9-]{10,}`, "g"),
  },
  {
    kind: "anthropic-key",
    pattern: new RegExp(`${B}sk-ant-[A-Za-z0-9_-]{10,}`, "g"),
  },
  {
    kind: "stripe-key",
    pattern: new RegExp(`${B}(?:sk|rk)_live_[A-Za-z0-9]{16,}`, "g"),
  },
  // OpenAI keys, old `sk-` and new `sk-proj-` alike
  { kind: "openai-key", pattern: new RegExp(`${B}sk-[A-Za-z0-9_-]{20,}`, "g") },
  // remote review bearer tokens
  {
    kind: "co-maintainer-token",
    pattern: new RegExp(`${B}cmr_[A-Za-z0-9_-]{20,}`, "g"),
  },
  {
    kind: "aws-access-key",
    pattern: new RegExp(`${B}(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])`, "g"),
  },
  {
    kind: "slack-token",
    pattern: new RegExp(`${B}xox[abeprs]-[A-Za-z0-9-]{10,}`, "g"),
  },
  { kind: "google-key", pattern: new RegExp(`${B}AIza[A-Za-z0-9_-]{35}`, "g") },
  {
    kind: "gitlab-token",
    pattern: new RegExp(`${B}glpat-[A-Za-z0-9_-]{20,}`, "g"),
  },
  { kind: "npm-token", pattern: new RegExp(`${B}npm_[A-Za-z0-9]{36}`, "g") },
];

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
  for (const { pattern } of SECRETS) {
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
        /[A-Za-z0-9+/=]{16,}/g,
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
