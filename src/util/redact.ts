/** Matches known secret shapes, not a generic "long random string"
 * heuristic — too many false positives on commit SHAs and hashes. */
const PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // ghp_, gho_, ghu_, ghs_, ghr_ (classic GitHub PATs and tokens)
  /github_pat_[A-Za-z0-9_]{20,}/g, // fine-grained GitHub PATs
  /sk-or-[A-Za-z0-9-]{10,}/g, // OpenRouter keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redact(text: string): string {
  let result = text;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}

/** Fenced blocks and inline code spans. The capture group puts code on odd
 * split indices, so prose can be cleaned without rewriting the code. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

export function outsideCode(
  text: string,
  clean: (prose: string) => string,
): string {
  return text
    .split(CODE)
    .map((part, index) => index % 2 === 1 ? part : clean(part))
    .join("");
}

/** Dashboard and other human-readable copy. Secrets out, no dash, no
 * semicolon. Code keeps its own punctuation or it stops compiling. */
export function safeCopy(text: string): string {
  return outsideCode(
    redact(text),
    (prose) => prose.replaceAll("\u2014", ", ").replaceAll(";", "."),
  );
}
