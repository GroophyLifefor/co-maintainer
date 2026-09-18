type Args = Record<string, unknown>;

export function toolError(message: string): string {
  return `Tool error: ${message}`;
}

export function rejectUnknownKeys(
  args: Args,
  allowed: ReadonlySet<string>,
): string | null {
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) return toolError(`unknown key: ${key}`);
  }
  return null;
}

export function rejectFlagLike(value: string, label: string): string | null {
  if (value.startsWith("-")) {
    return toolError(`${label} must not start with '-'`);
  }
  return null;
}

/** `codegraph_exec.ts` routes through `cmd /c` on Windows (the CLI is a `.cmd`
 * shim), and `cmd.exe` re-parses every argument, so a value carrying `&`, `|`,
 * `>` or `%` can append a second command. None of them have a legitimate place
 * in a search term, symbol name or repo-relative path, so refuse them. */
export function rejectShellMetacharacters(
  value: string,
  label: string,
): string | null {
  if (/[&|<>^%\r\n]/.test(value)) {
    return toolError(`${label} must not contain shell metacharacters`);
  }
  return null;
}

/** Repo-relative path only — no `..`, no absolute paths (plan E103). */
export function rejectEscapingPath(file: string): string | null {
  const flag = rejectFlagLike(file, "file");
  if (flag) return flag;
  const shell = rejectShellMetacharacters(file, "file");
  if (shell) return shell;
  const norm = file.replace(/\\/g, "/");
  if (
    norm.startsWith("/") ||
    norm.startsWith("//") ||
    /^[A-Za-z]:\//.test(norm) ||
    /^[A-Za-z]:$/.test(norm) ||
    norm.split("/").includes("..")
  ) {
    return toolError("file must stay inside the repository");
  }
  return null;
}

export function guardToolArgs(
  args: Args,
  allowed: ReadonlySet<string>,
): string | null {
  const unknown = rejectUnknownKeys(args, allowed);
  if (unknown) return unknown;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const shell = rejectShellMetacharacters(value, key);
    if (shell) return shell;
  }
  return null;
}
