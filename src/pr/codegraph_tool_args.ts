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

/** Repo-relative path only — no `..`, no absolute paths (plan E103). */
export function rejectEscapingPath(file: string): string | null {
  const flag = rejectFlagLike(file, "file");
  if (flag) return flag;
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
  return rejectUnknownKeys(args, allowed);
}
