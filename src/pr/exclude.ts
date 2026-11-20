/** A repository's review exclude pattern: changed files whose path matches it
 * are dropped as soon as the pull request's file list loads, so they never
 * get a diff section, a summary or a place in the prompt. Only reviews use
 * it, init and sync still read every file. */

/** Why a pattern cannot be saved, or undefined when it can. Blank is valid
 * and means no pattern. */
export function excludePatternError(pattern: string): string | undefined {
  if (pattern.trim() === "") return undefined;
  try {
    new RegExp(pattern);
    return undefined;
  } catch (error) {
    return `The exclude pattern is not a valid regular expression: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

export type ExcludeResult<T> = {
  kept: T[];
  /** How many files the pattern removed. */
  excluded: number;
};

/** Splits the changed files by the pattern. A file matches when its path
 * does, or for a rename when its old path does. No pattern, or one that does
 * not compile (a hand edited config), keeps every file, and `warn` says why. */
export function applyExclude<T extends Record<string, unknown>>(
  files: T[],
  pattern: string | undefined,
  warn: (message: string) => void = () => {},
): ExcludeResult<T> {
  if (!pattern || pattern.trim() === "") return { kept: files, excluded: 0 };
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    warn(`exclude pattern ignored · not a valid regular expression`);
    return { kept: files, excluded: 0 };
  }
  const kept = files.filter((file) => {
    const path = String(file.filename ?? "");
    const previous =
      typeof file.previous_filename === "string" ? file.previous_filename : "";
    return !(regex.test(path) || (previous !== "" && regex.test(previous)));
  });
  return { kept, excluded: files.length - kept.length };
}

/** The prompt line that tells the model files were left out on purpose, so
 * it does not guess about code it cannot see. Empty when nothing was. */
export function excludedPromptNote(excluded: number): string {
  if (excluded === 0) return "";
  const files = excluded === 1 ? "1 changed file" : `${excluded} changed files`;
  return `\n\nEXCLUDED BY THE REPOSITORY: ${files} matched this repository's review exclude pattern and are not shown. They were left out on purpose. Do not raise findings about them.`;
}
