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

/** Dashboard and other human-readable copy. Secrets out, no dash, no
 * semicolon. */
export function safeCopy(text: string): string {
  return redact(text).replaceAll("\u2014", ", ").replaceAll(";", ".");
}
